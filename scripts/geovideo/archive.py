#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.35",
#   "fsspec[http]>=2025.3",
#   "numpy>=2.0",
#   "requests>=2.32",
#   "s3fs>=2025.3",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""Incremental GeoVideo archive: immutable, calendar-aligned chunks plus a per-source S3 index.

archive.json declares, per archive source, the time windows to cover. Each window
selects every calendar chunk it touches; a chunk holds all source timestamps of
its period up to now. A chunk key hashes the encoding profile and the exact
timestamps (every one of them), so unchanged chunks are never rendered again. Chunks still inside
the revision horizon carry a daily stamp and are re-rendered until they settle.

Usage:
  uv run scripts/geovideo/archive.py plan [--source <uuid>] [--summary]
  uv run scripts/geovideo/archive.py run [--source <uuid>] [--budget 5h] [--max-chunks N]
  uv run scripts/geovideo/archive.py domain --source <uuid>
"""

from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, wait
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render  # noqa: E402
import render_vector  # noqa: E402

ARCHIVE_PATH = Path(__file__).resolve().parent / "archive.json"
INDEX_SCHEMA_VERSION = 1
# A growing chunk is re-rendered at each new timestamp, so live sources use short chunks;
# final historical data favors longer, uninterrupted playback.
CHUNK_BY_CADENCE = {
    "historical": {"PT1H": "P1M", "PT3H": "P1M", "PT6H": "P1Y", "P1D": "P1Y", "P1M": "P10Y"},
    "live": {"PT1H": "P1M", "PT3H": "P1M", "PT6H": "P1M", "P1D": "P1M", "P1M": "P1Y"},
}
CHUNK_PERIODS = {"P1M", "P1Y", "P10Y"}
DEFAULT_REVISION_HORIZON = "P10D"
SUPERSEDED_GRACE = np.timedelta64(1, "D")
SCALAR_MAX_SIZE = (2048, 1024)
# Waits before retrying a chunk after a dropped connection to a store or bucket.
TRANSIENT_RETRY_DELAYS = (30, 60)
# Exception classes, matched by name along the MRO, that a later attempt can
# get past: aiohttp (Zarr reads), requests, and the standard library.
TRANSIENT_ERRORS = {"ClientError", "RequestException", "ConnectionError", "TimeoutError"}


def utc_now() -> np.datetime64:
    return np.datetime64(datetime.now(timezone.utc).replace(tzinfo=None), "ns")


# ── configuration ───────────────────────────────────────────────────────

def load_archives(path: Path = ARCHIVE_PATH) -> dict[str, Any]:
    data = json.loads(path.read_text())
    seen: set[str] = set()
    for archive in data["archives"]:
        render.uuid4(render.required(archive, "sourceId"), "sourceId")
        render.uuid4(render.required(archive, "catalogEntryId"), "catalogEntryId")
        if archive["sourceId"] in seen:
            raise ValueError(f"Duplicate archive sourceId: {archive['sourceId']}")
        seen.add(archive["sourceId"])
        windows = render.required(archive, "windows")
        if not isinstance(windows, list) or not windows:
            raise ValueError(f"{archive['sourceId']}: windows must be a non-empty list")
        for window in windows:
            window_interval(window, np.datetime64("2000-01-01", "ns"))
        if archive.get("chunk") is not None and archive["chunk"] not in CHUNK_PERIODS:
            raise ValueError(f"{archive['sourceId']}: chunk must be one of {sorted(CHUNK_PERIODS)}")
    return data


def catalog_layer(entry_id: str) -> dict[str, Any]:
    catalog = json.loads(render.CATALOG_PATH.read_text())
    for layer in catalog["layers"]:
        if layer["id"] == entry_id:
            return layer
    raise ValueError(f"Unknown catalog layer: {entry_id}")


def chunk_period(archive: dict[str, Any], layer: dict[str, Any]) -> str:
    if archive.get("chunk"):
        return archive["chunk"]
    temporal = render.zarr_source(layer).get("temporal") or {}
    table = CHUNK_BY_CADENCE["historical" if temporal.get("mode") == "historical" else "live"]
    if temporal.get("cadence") not in table:
        raise ValueError(f"{archive['sourceId']}: set chunk explicitly for cadence {temporal.get('cadence')!r}")
    return table[temporal["cadence"]]


def revision_horizon(archive: dict[str, Any], layer: dict[str, Any]) -> np.timedelta64 | None:
    """Recent data may still be revised upstream; historical reprocessings are final."""
    mode = (render.zarr_source(layer).get("temporal") or {}).get("mode")
    value = archive.get("revisionHorizon", None if mode == "historical" else DEFAULT_REVISION_HORIZON)
    if value in (None, "P0D"):
        return None
    return render_vector.parse_step(value)


def window_interval(window: dict[str, Any], now: np.datetime64) -> tuple[np.datetime64, np.datetime64]:
    """Closed interval of a window; full coverage is bounded later by the source time axis."""
    if window.get("full") is True and len(window) == 1:
        return np.datetime64("1900-01-01", "ns"), now
    if set(window) == {"rolling"}:
        return now - render_vector.parse_step(window["rolling"]), now
    if set(window) == {"start"}:
        return render.parse_iso(window["start"]), now
    if set(window) == {"start", "end"}:
        start, end = render.parse_iso(window["start"]), render.parse_iso(window["end"])
        if end < start:
            raise ValueError("window end must not precede start")
        return start, end
    raise ValueError(f"window must be {{full: true}}, {{rolling}}, {{start}} or {{start, end}}: {window}")


# ── chunk planning (pure) ───────────────────────────────────────────────

def period_start(value: np.datetime64, period: str) -> np.datetime64:
    if period == "P1M":
        return value.astype("datetime64[M]").astype("datetime64[ns]")
    year = int(value.astype("datetime64[Y]").astype(int)) + 1970
    if period == "P10Y":
        year -= year % 10
    return np.datetime64(f"{year:04d}-01-01", "ns")


def period_end(start: np.datetime64, period: str) -> np.datetime64:
    """Exclusive end of the calendar period starting at `start`."""
    if period == "P1M":
        return (start.astype("datetime64[M]") + np.timedelta64(1, "M")).astype("datetime64[ns]")
    years = 10 if period == "P10Y" else 1
    return (start.astype("datetime64[Y]") + np.timedelta64(years, "Y")).astype("datetime64[ns]")


def step_filter(times: np.ndarray, step: np.timedelta64 | None) -> np.ndarray:
    """Keep timestamps on the epoch-anchored step grid, so chunk contents never depend on window starts."""
    if step is None:
        return times
    offsets = (times - np.datetime64(0, "ns")).astype("timedelta64[ns]").astype(np.int64)
    return times[offsets % step.astype("timedelta64[ns]").astype(np.int64) == 0]


def iso(value: np.datetime64) -> str:
    return np.datetime_as_string(value.astype("datetime64[s]"), unit="s") + "Z"


def plan_chunks(
    times: np.ndarray, windows: list[dict[str, Any]], period: str, now: np.datetime64,
    step: np.timedelta64 | None = None, horizon: np.timedelta64 | None = None,
) -> list[dict[str, Any]]:
    """Chunks required by the windows: whole calendar periods, newest first.

    Forecast steps after `now` are excluded; chunks with fewer than two samples
    wait for more data.
    """
    available = step_filter(np.sort(times[times <= now]).astype("datetime64[ns]"), step)
    if available.size == 0:
        return []
    periods: set[np.datetime64] = set()
    for window in windows:
        low, high = window_interval(window, now)
        low, high = max(low, available[0]), min(high, available[-1])
        if high < low:
            continue
        current = period_start(low, period)
        while current <= high:
            periods.add(current)
            current = period_end(current, period)
    chunks = []
    stamp = np.datetime64(now, "D")
    for start in sorted(periods, reverse=True):
        end = period_end(start, period)
        samples = available[(available >= start) & (available < end)]
        if samples.size < 2:
            continue
        provisional = horizon is not None and samples[-1] > now - horizon
        chunks.append({
            "period": {"start": iso(start), "end": iso(end)},
            "samples": [iso(value) for value in samples],
            "revision": str(stamp) if provisional else None,
        })
    return chunks


def encoding_profile(archive: dict[str, Any], layer: dict[str, Any]) -> dict[str, Any]:
    """Everything that changes encoded values. Palette and vibrance are applied in WebGL and excluded."""
    source = render.zarr_source(layer)
    profile = {
        "kind": layer["kind"],
        "catalogEntryId": layer["id"],
        "sourceId": archive["sourceId"],
        "store": source["endpoints"]["field"],
        "variables": source["variables"],
        "bounds": archive.get("bounds"),
        "step": archive.get("step"),
        # Encoder threads only schedule work; they do not change encoded values.
        "output": {key: value for key, value in archive.get("output", {}).items() if key != "threads"},
    }
    if layer["kind"] == "scalar":
        profile["format"] = "geovideo-v3-scalar-luma-static-mask-intersection-exact-samples"
        profile["colorDomain"] = render.catalog_style(layer)["colorDomain"]
        profile["framesPerSample"] = archive.get("framesPerSample", 1)
    else:
        profile["format"] = "geovideo-v3-vector-luma-stacked-uv"
    return profile


def chunk_key(profile: dict[str, Any], chunk: dict[str, Any]) -> str:
    material = {"profile": profile, "samples": chunk["samples"], "revision": chunk["revision"]}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:12]


def pending_chunks(chunks: list[dict[str, Any]], index: dict[str, Any]) -> list[dict[str, Any]]:
    present = {chunk["period"]["start"]: chunk["key"] for chunk in index["chunks"]}
    return [chunk for chunk in chunks if present.get(chunk["period"]["start"]) != chunk["key"]]


# ── index (pure) ────────────────────────────────────────────────────────

def empty_index(archive: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": INDEX_SCHEMA_VERSION,
        "type": "geovideo-index",
        "catalogEntryId": archive["catalogEntryId"],
        "sourceId": archive["sourceId"],
        "updatedAt": None,
        "chunks": [],
        "superseded": [],
    }


def merge_chunk(index: dict[str, Any], chunk: dict[str, Any], now: np.datetime64) -> dict[str, Any]:
    """Insert or replace the chunk of a period; a replaced key is kept for a grace period."""
    samples = chunk["samples"]
    entry = {
        "period": chunk["period"],
        "start": samples[0],
        "end": samples[-1],
        "samples": len(samples),
        "key": chunk["key"],
        "manifestUrl": f"{chunk['key']}/manifest.json",
        "provisional": chunk["revision"] is not None,
        **({"gaps": chunk["gaps"]} if chunk.get("gaps") else {}),
    }
    chunks, superseded = [], list(index["superseded"])
    for existing in index["chunks"]:
        if existing["period"]["start"] != entry["period"]["start"]:
            chunks.append(existing)
        elif existing["key"] != entry["key"]:
            superseded.append({"key": existing["key"], "at": iso(now)})
    chunks.append(entry)
    chunks.sort(key=lambda item: item["period"]["start"])
    return {**index, "updatedAt": iso(now), "chunks": chunks, "superseded": superseded}


def expired_superseded(index: dict[str, Any], now: np.datetime64) -> tuple[list[str], dict[str, Any]]:
    """Keys whose grace period elapsed, so cached older indexes no longer reference them."""
    live = {chunk["key"] for chunk in index["chunks"]}
    expired, kept = [], []
    for item in index["superseded"]:
        if item["key"] in live:
            continue
        if now - render.parse_iso(item["at"]) >= SUPERSEDED_GRACE:
            expired.append(item["key"])
        else:
            kept.append(item)
    return expired, {**index, "superseded": kept}


# ── source data ─────────────────────────────────────────────────────────

def open_source(layer: dict[str, Any]) -> Any:
    return render.open_arco_zarr(render.zarr_source(layer)["endpoints"]["field"])


def source_bounds(dataset: Any) -> list[float]:
    latitude = np.asarray(dataset["latitude"].values, dtype=np.float64)
    longitude = np.asarray(dataset["longitude"].values, dtype=np.float64)
    return [float(longitude.min()), float(latitude.min()), float(longitude.max()), float(latitude.max())]


def scalar_size(dataset: Any, bounds: list[float]) -> tuple[int, int]:
    """Native resolution within the H.264 level 4.1 frame budget, aspect preserved, even dimensions."""
    latitude = np.asarray(dataset["latitude"].values, dtype=np.float64)
    longitude = np.asarray(dataset["longitude"].values, dtype=np.float64)
    west, south, east, north = bounds
    width = int(np.count_nonzero((longitude >= west) & (longitude <= east)))
    height = int(np.count_nonzero((latitude >= south) & (latitude <= north)))
    scale = min(1.0, SCALAR_MAX_SIZE[0] / width, SCALAR_MAX_SIZE[1] / height)
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


# ── rendering and publication ───────────────────────────────────────────

def object_prefix(upload: dict[str, Any], archive: dict[str, Any]) -> str:
    return f"{upload.get('prefix', 'geovideo').strip('/')}/{archive['catalogEntryId']}/{archive['sourceId']}"


def chunk_directory(archive: dict[str, Any], key: str) -> Path:
    return render.ROOT / "artifacts" / "geovideo-archive" / archive["sourceId"] / key


def without_gaps(chunk: dict[str, Any], empty: list[str]) -> dict[str, Any]:
    """The chunk minus upstream gaps; its key stays tied to the planned timestamps."""
    samples = [sample for sample in chunk["samples"] if sample not in set(empty)]
    if len(samples) < 2:
        raise ValueError(f"Chunk {chunk['period']['start']} has fewer than two timestamps with data")
    return {**chunk, "samples": samples, "gaps": sorted(set(chunk.get("gaps", [])) | set(empty))}


def render_chunk(archive: dict[str, Any], layer: dict[str, Any], chunk: dict[str, Any],
                 threads: int | None = None) -> dict[str, Any]:
    """Render one chunk, dropping upstream gaps once; return the chunk as encoded."""
    try:
        render_samples(archive, layer, chunk, threads)
        return chunk
    except render.EmptySamplesError as exc:
        print(f"Dropping upstream gaps {exc.samples} from {chunk['period']['start']}", file=sys.stderr, flush=True)
        chunk = without_gaps(chunk, exc.samples)
        render_samples(archive, layer, chunk, threads)
        return chunk


def render_samples(archive: dict[str, Any], layer: dict[str, Any], chunk: dict[str, Any],
                   threads: int | None = None) -> Path:
    """Encoder threads only share CPUs between workers and are not part of the key."""
    dataset = open_source(layer)
    directory = chunk_directory(archive, chunk["key"])
    shutil.rmtree(directory, ignore_errors=True)
    bounds = archive.get("bounds") or source_bounds(dataset)
    output = {**archive.get("output", {}), "directory": str(directory.parent)}
    if threads and "threads" not in output:
        output["threads"] = threads
    if layer["kind"] == "scalar":
        if "width" not in output or "height" not in output:
            output["width"], output["height"] = scalar_size(dataset, bounds)
        config = render.validate_config({
            "id": archive["sourceId"],
            "catalogEntryId": layer["id"],
            "sampling": {
                "kind": "native",
                "values": chunk["samples"],
                "framesPerSample": archive.get("framesPerSample", 1),
            },
            "bounds": bounds,
            "output": output,
        }, layer)
        frame_count = round(config["durationSeconds"] * config["output"]["fps"])
        summary = {"artifactId": chunk["key"], "directory": str(directory), "frames": frame_count}
        render.render_artifact(config, layer, directory, frame_count, summary)
    else:
        config = render_vector.validate_config({
            "id": archive["sourceId"],
            "catalogEntryId": layer["id"],
            "dateStart": chunk["samples"][0],
            "dateEnd": chunk["samples"][-1],
            "times": chunk["samples"],
            **({"bounds": archive["bounds"]} if archive.get("bounds") else {}),
            "output": output,
        }, layer)
        render_vector.render(config, layer, directory, None)
    return directory


def read_index(client: Any, bucket: str, key: str, archive: dict[str, Any]) -> dict[str, Any]:
    try:
        body = client.get_object(Bucket=bucket, Key=key)["Body"].read()
    except client.exceptions.NoSuchKey:
        return empty_index(archive)
    index = json.loads(body)
    if index.get("schemaVersion") != INDEX_SCHEMA_VERSION or index.get("sourceId") != archive["sourceId"]:
        raise RuntimeError(f"Unexpected GeoVideo index at {key}")
    return index


def write_index(client: Any, bucket: str, key: str, index: dict[str, Any]) -> None:
    client.put_object(
        Bucket=bucket, Key=key, Body=(json.dumps(index, indent=2) + "\n").encode(),
        ACL="public-read", ContentType="application/json", CacheControl="public,max-age=60",
    )


def delete_chunk_objects(client: Any, bucket: str, prefix: str, key: str) -> None:
    for name in ("video.mp4", "mask.png", "manifest.json"):
        client.delete_object(Bucket=bucket, Key=f"{prefix}/{key}/{name}")


# ── commands ────────────────────────────────────────────────────────────

def parse_budget(value: str) -> float:
    units = {"s": 1, "m": 60, "h": 3600}
    if not value or value[-1] not in units or not value[:-1].replace(".", "", 1).isdigit():
        raise argparse.ArgumentTypeError("budget must look like 90m or 5h")
    return float(value[:-1]) * units[value[-1]]


def selected_archives(data: dict[str, Any], source: str | None) -> list[dict[str, Any]]:
    archives = [archive for archive in data["archives"] if source in (None, archive["sourceId"])]
    if source and not archives:
        raise ValueError(f"No archive for source {source}")
    return archives


def interleave(queues: list[dict[str, Any]]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Round-robin across archives, each archive's chunks in their (newest-first) order."""
    order = []
    for position in range(max((len(queue["pending"]) for queue in queues), default=0)):
        order.extend((queue, queue["pending"][position]) for queue in queues if position < len(queue["pending"]))
    return order


def is_transient(exc: BaseException) -> bool:
    """A network failure, here or in its cause chain, rather than a rendering one."""
    error: BaseException | None = exc
    while error is not None:
        if any(cls.__name__ in TRANSIENT_ERRORS for cls in type(error).__mro__):
            return True
        error = error.__cause__ or error.__context__
    return False


def render_and_publish(archive: dict[str, Any], layer: dict[str, Any], chunk: dict[str, Any],
                       upload: dict[str, Any], prefix: str, threads: int | None) -> dict[str, Any]:
    """Worker task: render, validate, and upload one chunk; the caller owns the index.

    A dropped connection retries the chunk, so one network hiccup does not
    pause its archive for the rest of the run.
    """
    directory = chunk_directory(archive, chunk["key"])
    for delay in (*TRANSIENT_RETRY_DELAYS, None):
        try:
            rendered = render_chunk(archive, layer, chunk, threads)
            render.publish(directory, {"upload": upload}, rendered["key"], f"{prefix}/{rendered['key']}")
            return rendered
        except Exception as exc:
            if delay is None or not is_transient(exc):
                raise
            print(f"Network failure on {chunk['period']['start']}, retrying in {delay}s: {exc}",
                  file=sys.stderr, flush=True)
            time.sleep(delay)
        finally:
            shutil.rmtree(directory, ignore_errors=True)
    raise AssertionError("unreachable")


def resolve(archive: dict[str, Any], now: np.datetime64) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    layer = catalog_layer(archive["catalogEntryId"])
    if layer["kind"] == "vector" and not (archive.get("output") or {}).get("valueDomain"):
        raise ValueError(f"{archive['sourceId']}: vector archives pin output.valueDomain (see `archive.py domain`)")
    dataset = open_source(layer)
    times = np.asarray(dataset["time"].values).astype("datetime64[ns]")
    step = render_vector.parse_step(archive.get("step"))
    chunks = plan_chunks(times, archive["windows"], chunk_period(archive, layer), now, step,
                         revision_horizon(archive, layer))
    profile = encoding_profile(archive, layer)
    for chunk in chunks:
        chunk["key"] = chunk_key(profile, chunk)
    return layer, chunks


def summarize_plan(results: list[dict[str, Any]]) -> str:
    """Published/required chunks of each incomplete or failing archive, then the total."""
    lines = []
    for result in results:
        title = result.get("title") or result["sourceId"]
        if "error" in result:
            lines.append(f"{'error':>9}  {title}: {result['error']}")
        elif result["pending"]:
            lines.append(f"{result['present']:>4}/{result['required']:<4}  {title}")
    planned = [result for result in results if "error" not in result]
    present = sum(result["present"] for result in planned)
    required = sum(result["required"] for result in planned)
    share = f" ({100 * present / required:.1f}%)" if required else ""
    complete = sum(not result["pending"] for result in planned)
    lines.append(f"Total {present}/{required} chunks{share}; {complete}/{len(results)} archives complete")
    return "\n".join(lines)


def command_plan(args: argparse.Namespace) -> int:
    data = load_archives()
    client, env = render.s3_client()
    now = utc_now()
    results = []
    for archive in selected_archives(data, args.source):
        try:
            _layer, chunks = resolve(archive, now)
            prefix = object_prefix(data.get("upload", {}), archive)
            index = read_index(client, env["S3_BUCKET"], f"{prefix}/index.json", archive)
        except Exception as exc:
            results.append({"sourceId": archive["sourceId"], "title": archive.get("title"), "error": str(exc)})
            continue
        pending = pending_chunks(chunks, index)
        results.append({
            "sourceId": archive["sourceId"],
            "title": archive.get("title"),
            "required": len(chunks),
            "present": len(chunks) - len(pending),
            "pending": [{"period": chunk["period"]["start"], "samples": len(chunk["samples"]),
                         "key": chunk["key"], "provisional": chunk["revision"] is not None}
                        for chunk in pending],
        })
    print(summarize_plan(results) if args.summary else json.dumps(results, indent=2))
    return 1 if any("error" in result for result in results) else 0


def command_run(args: argparse.Namespace) -> int:
    """Round-robin over archives, newest chunk first, so no backlog starves the others.

    Workers render and upload; this process alone rewrites each archive index.
    """
    data = load_archives()
    upload = data.get("upload", {})
    client, env = render.s3_client()
    bucket = env["S3_BUCKET"]
    render.require_bucket_cors(client, bucket)
    deadline = time.monotonic() + args.budget
    failures: list[str] = []
    queues = []
    for archive in selected_archives(data, args.source):
        try:
            now = utc_now()
            layer, chunks = resolve(archive, now)
            prefix = object_prefix(upload, archive)
            index = read_index(client, bucket, f"{prefix}/index.json", archive)
            expired, index = expired_superseded(index, now)
            for key in expired:
                delete_chunk_objects(client, bucket, prefix, key)
            if expired:
                write_index(client, bucket, f"{prefix}/index.json", index)
        except Exception as exc:
            failures.append(f"{archive['sourceId']}: {exc}")
            print(f"Skipping {archive['sourceId']}: {exc}", file=sys.stderr, flush=True)
            continue
        queues.append({"archive": archive, "layer": layer, "prefix": prefix,
                       "index": index, "pending": pending_chunks(chunks, index)})
    threads = max(1, (os.cpu_count() or 1) // args.jobs)
    tasks = iter(interleave(queues))
    running: dict[Future, dict[str, Any]] = {}
    submitted = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        while True:
            while len(running) < args.jobs and time.monotonic() < deadline and (
                    args.max_chunks is None or submitted < args.max_chunks):
                task = next((item for item in tasks if not item[0].get("failed")), None)
                if task is None:
                    break
                queue, chunk = task
                print(f"Rendering {queue['archive']['sourceId']} {chunk['period']['start']} "
                      f"({len(chunk['samples'])} samples) -> {chunk['key']}", file=sys.stderr, flush=True)
                future = pool.submit(render_and_publish, queue["archive"], queue["layer"], chunk, upload,
                                     queue["prefix"], threads)
                running[future] = queue
                submitted += 1
            if not running:
                break
            done, _ = wait(running, return_when=FIRST_COMPLETED)
            for future in done:
                queue = running.pop(future)
                try:
                    chunk = future.result()
                    queue["index"] = merge_chunk(queue["index"], chunk, utc_now())
                    write_index(client, bucket, f"{queue['prefix']}/index.json", queue["index"])
                    print(f"Published {queue['archive']['sourceId']} {chunk['period']['start']}",
                          file=sys.stderr, flush=True)
                except Exception as exc:
                    failures.append(f"{queue['archive']['sourceId']}: {exc}")
                    print(f"Chunk failed, archive paused for this run: {exc}", file=sys.stderr, flush=True)
                    queue["failed"] = True
    if time.monotonic() >= deadline:
        print("Budget reached; remaining chunks resume on the next run", file=sys.stderr)
    return report_failures(failures)


def report_failures(failures: list[str]) -> int:
    for failure in failures:
        print(f"FAILED {failure}", file=sys.stderr)
    return 1 if failures else 0


def command_domain(args: argparse.Namespace) -> int:
    """Suggest a pinned vector valueDomain from a spread sample over the archive windows."""
    data = load_archives()
    archive = selected_archives(data, args.source)[0]
    layer = catalog_layer(archive["catalogEntryId"])
    if layer["kind"] != "vector":
        raise ValueError("domain applies to vector archives")
    dataset = open_source(layer)
    now = utc_now()
    times = np.asarray(dataset["time"].values).astype("datetime64[ns]")
    chunks = plan_chunks(times, archive["windows"], chunk_period(archive, layer), now,
                         render_vector.parse_step(archive.get("step")))
    samples = sorted({sample for chunk in chunks for sample in chunk["samples"]})
    picks = [samples[int(i)] for i in np.unique(np.linspace(0, len(samples) - 1, min(24, len(samples))).round())]
    output = {key: value for key, value in (archive.get("output") or {}).items() if key != "valueDomain"}
    config = render_vector.validate_config({
        "id": archive["sourceId"], "catalogEntryId": layer["id"],
        "dateStart": picks[0], "dateEnd": picks[-1], "times": picks,
        **({"bounds": archive["bounds"]} if archive.get("bounds") else {}),
        "output": output,
    }, layer)
    frames = render_vector.VectorFrames(layer, config)
    domain, _valid = render_vector.value_domain(frames, float(output.get("domainPercentile", 99.9)))
    print(json.dumps({"sourceId": archive["sourceId"], "valueDomain": domain, "unit": frames.unit,
                      "sampledFrames": len(picks)}, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan", help="List required and pending chunks")
    plan.add_argument("--source")
    plan.add_argument("--summary", action="store_true", help="Print progress per incomplete archive instead of JSON")
    run = commands.add_parser("run", help="Render, publish, and index pending chunks")
    run.add_argument("--source")
    run.add_argument("--budget", type=parse_budget, default=parse_budget("5h"))
    run.add_argument("--max-chunks", type=int)
    run.add_argument("--jobs", type=int, default=1, help="Chunks rendered in parallel")
    domain = commands.add_parser("domain", help="Suggest a pinned vector valueDomain")
    domain.add_argument("--source", required=True)
    args = parser.parse_args()
    return {"plan": command_plan, "run": command_run, "domain": command_domain}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
