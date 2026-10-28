"""Shared plumbing for the file → Zarr pipelines: store targets, appends, budgets and the day driver.

Each product converts provider files into two Zarr v2 stores shaped like
Copernicus Marine ARCO, which zartigl and the GeoVideo renderer already read:
`timeChunked.zarr` (one time step per chunk, for maps) and `geoChunked.zarr`
(long time chunks over small tiles, for point series). Stores are written in
place; readers only see a new time step once the consolidated metadata,
written last, lists it.

A product supplies a `Product` (fetch one day, read it, encode it); `main`
gives it the `plan`, `run` and `sync-geo` commands. A day is appended whole,
whatever its number of time steps (`stepsPerDay` in the config), so a run
resumes after the last stored day.
"""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
from typing import Any, Callable

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from s3_bucket import require_bucket_cors, s3_client  # noqa: E402

STORE_NAMES = ("timeChunked", "geoChunked")
# The time coordinate is read whole by the browser, so it lives in a single chunk.
TIME_COORDINATE_CHUNK = 1 << 16


@dataclass(frozen=True)
class Target:
    """Where a product's stores live: a bucket prefix, or a local directory for tests and dry runs."""

    root: str
    storage_options: dict[str, Any] | None = None
    public_base: str | None = None

    def store(self, name: str) -> Any:
        if self.storage_options is None:
            return str(Path(self.root) / f"{name}.zarr")
        import fsspec

        return fsspec.get_mapper(f"{self.root}/{name}.zarr", **self.storage_options)

    def public_url(self, name: str) -> str | None:
        return f"{self.public_base}/{name}.zarr" if self.public_base else None


def local_target(directory: Path) -> Target:
    directory.mkdir(parents=True, exist_ok=True)
    return Target(root=str(directory))


def bucket_target(prefix: str) -> Target:
    """Public-read objects under `prefix` of the zartigl bucket, after checking its CORS rules."""
    client, env = s3_client()
    require_bucket_cors(client, env["S3_BUCKET"])
    return Target(
        root=f"s3://{env['S3_BUCKET']}/{prefix.strip('/')}",
        storage_options={
            "key": env["S3_KEY"],
            "secret": env["S3_SECRET"],
            "client_kwargs": {"endpoint_url": env["S3_ENDPOINT"]},
            "s3_additional_kwargs": {"ACL": "public-read"},
        },
        public_base=f"{env['S3_ENDPOINT'].rstrip('/')}/{env['S3_BUCKET']}/{prefix.strip('/')}",
    )


def target_from_args(args: argparse.Namespace, prefix: str) -> Target:
    if args.local:
        return local_target(Path(args.local))
    return bucket_target(prefix)


def stored_times(target: Target, name: str) -> np.ndarray:
    """Time axis of a store, empty when it does not exist yet."""
    try:
        dataset = xr.open_zarr(target.store(name), consolidated=True, zarr_format=2)
    except (FileNotFoundError, KeyError, ValueError):
        return np.array([], dtype="datetime64[ns]")
    return dataset["time"].values.astype("datetime64[ns]")


def open_store(target: Target, name: str, *, decode: bool = True) -> xr.Dataset:
    return xr.open_zarr(target.store(name), consolidated=True, zarr_format=2, mask_and_scale=decode)


def write(dataset: xr.Dataset, target: Target, name: str, chunks: dict[str, int],
          encodings: dict[str, dict[str, Any]], *, append: bool) -> None:
    """Create the store or append along time; dask chunks must already match the store chunks."""
    store = target.store(name)
    if append:
        dataset.to_zarr(store, append_dim="time", consolidated=True, zarr_format=2, write_empty_chunks=False)
        return
    encoding = {
        variable: {**encodings[variable], "chunks": tuple(chunks[dim] for dim in dataset[variable].dims)}
        for variable in dataset.data_vars
    }
    encoding["time"] = {**encodings["time"], "chunks": (TIME_COORDINATE_CHUNK,)}
    dataset.to_zarr(store, mode="w-", consolidated=True, zarr_format=2, encoding=encoding,
                    write_empty_chunks=False)


def append_chunks(existing: int, count: int, size: int) -> tuple[int, ...]:
    """Dask time chunks for appending `count` steps so each write fills exactly one store chunk."""
    first = min(count, (-existing) % size or size)
    rest = count - first
    return (first,) + (size,) * (rest // size) + ((rest % size,) if rest % size else ())


def parse_budget(value: str) -> float:
    units = {"s": 1, "m": 60, "h": 3600}
    if not value or value[-1] not in units or not value[:-1].replace(".", "", 1).isdigit():
        raise argparse.ArgumentTypeError("budget must look like 90m or 5h")
    return float(value[:-1]) * units[value[-1]]


def as_day(value: np.datetime64) -> date:
    return value.astype("datetime64[D]").astype(date)


def pending_days(stored: np.ndarray, start: date, today: date) -> list[date]:
    """Days after the last stored one (or from `start`) up to yesterday; the store never has holes."""
    first = as_day(stored[-1]) + timedelta(days=1) if stored.size else start
    return [first + timedelta(days=offset) for offset in range((today - first).days)]


def store_encodings(dataset: xr.Dataset) -> dict[str, dict[str, Any]]:
    """The on-disk encoding of an opened store, to write its variables again elsewhere."""
    keep = ("dtype", "_FillValue", "scale_factor", "add_offset", "compressors", "units", "calendar")
    return {
        name: {key: value for key, value in dataset[name].encoding.items() if key in keep}
        for name in (*dataset.data_vars, "time")
    }


@dataclass(frozen=True)
class Product:
    """What a pipeline provides to the shared driver.

    `fetch_day(config, day, workdir)` downloads one day and returns a handle, or
    None when the provider has not published it yet; it runs in worker threads.
    `read_day(handle, day)` returns the day as (time, latitude, longitude) in the
    store layout, or None when the download does not hold it (not published
    yet); `to_store(dataset)` returns it with its store encodings;
    `release(handle)` frees the downloaded files once the day is stored.
    """

    label: str
    fetch_day: Callable[[dict[str, Any], date, Path], Any]
    read_day: Callable[[Any, date], xr.Dataset | None]
    to_store: Callable[[xr.Dataset], tuple[xr.Dataset, dict[str, dict[str, Any]]]]
    release: Callable[[Any], None] = lambda _handle: None


def steps_per_day(config: dict[str, Any]) -> int:
    return int(config.get("stepsPerDay", 1))


def append_day(target: Target, config: dict[str, Any], dataset: xr.Dataset,
               specs: dict[str, dict[str, Any]], first: bool) -> None:
    if dataset.sizes["time"] != steps_per_day(config):
        raise RuntimeError(f"Expected {steps_per_day(config)} time steps per day, got {dataset.sizes['time']}")
    chunks = config["stores"]["timeChunked"]
    write(dataset.chunk(chunks), target, "timeChunked", chunks, specs, append=not first)


def run(args: argparse.Namespace, config: dict[str, Any], product: Product) -> None:
    target = target_from_args(args, config["prefix"])
    today = datetime.now(timezone.utc).date()
    stored = stored_times(target, "timeChunked")
    days = pending_days(stored, date.fromisoformat(config["start"]), today)[:args.max_days]
    deadline = time.monotonic() + args.budget
    recent = today - timedelta(days=config["publicationDelayDays"])
    written = 0
    workdir = Path(tempfile.mkdtemp(prefix=f"{product.label}-"))
    try:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futures: dict[date, Future] = {}
            for index, day in enumerate(days):
                for ahead in days[index:index + args.jobs]:
                    if ahead not in futures:
                        futures[ahead] = pool.submit(product.fetch_day, config, ahead, workdir)
                if time.monotonic() > deadline:
                    print(f"Budget reached before {day}", flush=True)
                    break
                handle = futures.pop(day).result()
                day_data = None if handle is None else product.read_day(handle, day)
                if day_data is None:
                    if day >= recent:
                        print(f"{day} not published yet", flush=True)
                        break
                    raise RuntimeError(f"{product.label}: {day} is missing and older than the publication delay")
                dataset, specs = product.to_store(day_data)
                append_day(target, config, dataset, specs, first=stored.size == 0 and written == 0)
                product.release(handle)
                written += 1
                print(f"{day} appended", flush=True)
            for future in futures.values():
                future.cancel()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    print(json.dumps({"appended": written, "store": target.public_url("timeChunked")}))


def sync_geo(args: argparse.Namespace, config: dict[str, Any]) -> None:
    """Append to geoChunked.zarr the steps timeChunked.zarr already holds, one store time chunk at a time."""
    import dask

    target = target_from_args(args, config["prefix"])
    source_times = stored_times(target, "timeChunked")
    geo_times = stored_times(target, "geoChunked")
    if not np.array_equal(source_times[:geo_times.size], geo_times):
        raise RuntimeError("geoChunked.zarr is not a prefix of timeChunked.zarr; rebuild it")
    lag = source_times.size - geo_times.size
    if lag == 0 or (lag < config["geoSyncMinLagDays"] * steps_per_day(config) and not args.force):
        print(json.dumps({"appended": 0, "lag": int(lag)}))
        return
    chunks = config["stores"]["geoChunked"]
    source = open_store(target, "timeChunked")
    specs = store_encodings(source)
    deadline = time.monotonic() + args.budget
    start = geo_times.size
    with dask.config.set(scheduler="threads", num_workers=args.jobs):
        for size in append_chunks(geo_times.size, lag, chunks["time"]):
            if time.monotonic() > deadline:
                print("Budget reached", flush=True)
                break
            block = source.isel(time=slice(start, start + size))
            for variable in block.variables.values():
                variable.encoding = {}
            block = block.chunk({**chunks, "time": size})
            write(block, target, "geoChunked", chunks, specs, append=start > 0)
            start += size
            print(f"geoChunked: {start}/{source_times.size} steps", flush=True)
    print(json.dumps({"appended": start - geo_times.size, "store": target.public_url("geoChunked")}))


def plan(args: argparse.Namespace, config: dict[str, Any]) -> None:
    target = target_from_args(args, config["prefix"])
    today = datetime.now(timezone.utc).date()
    stored = stored_times(target, "timeChunked")
    geo = stored_times(target, "geoChunked")
    days = pending_days(stored, date.fromisoformat(config["start"]), today)
    per_day = steps_per_day(config)
    print(json.dumps({
        "timeChunked": {"days": int(stored.size) // per_day, "last": str(as_day(stored[-1])) if stored.size else None},
        "geoChunked": {"days": int(geo.size) // per_day},
        "pending": {"days": len(days), "first": str(days[0]) if days else None},
    }, indent=2))


def main(doc: str, config_path: Path, product: Callable[[dict[str, Any]], Product]) -> None:
    """The plan / run / sync-geo command line of a product, built from the config in use."""
    parser = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "run", "sync-geo"):
        command = commands.add_parser(name)
        command.add_argument("--local", help="Write stores to this directory instead of the bucket")
        command.add_argument("--config", type=Path, default=config_path)
        if name != "plan":
            command.add_argument("--budget", type=parse_budget, default=parse_budget("5h"),
                                 help="Time after which no new day or chunk starts")
            command.add_argument("--jobs", type=int, default=4)
        if name == "run":
            command.add_argument("--max-days", type=int, help="Stop after this many days")
        if name == "sync-geo":
            command.add_argument("--force", action="store_true", help="Sync even below geoSyncMinLagDays")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if args.command == "run":
        run(args, config, product(config))
    elif args.command == "sync-geo":
        sync_geo(args, config)
    else:
        plan(args, config)
