#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "aiohttp>=3.9",
#   "boto3>=1.35",
#   "fsspec>=2025.3",
#   "numpy>=2.0",
#   "requests>=2.32",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""Generate and optionally publish a vector GeoVideo artifact (vector-luma manifest).

Each native time step becomes one H.264 frame. u and v are block-averaged to a
coarser grid, quantized with a sqrt transfer to limited-range 8-bit codes and
written straight into the luma plane, u rows above v rows. Browsers decode one
frame per time step (no continuous playback); see src/lib/GeoVideoVectorSource.ts.

Usage:
  uv run scripts/geovideo/render_vector.py scripts/geovideo/examples/swell-2026-08-09.json --dry-run
  uv run scripts/geovideo/render_vector.py scripts/geovideo/examples/swell-2026-08-09.json --upload
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterator

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render import (  # noqa: E402
    CATALOG_PATH,
    ROOT,
    EmptySamplesError,
    fill_invalid_for_video,
    open_arco_zarr,
    parse_iso,
    publish,
    required,
    sample_iso,
    surface_index,
    uuid4,
    write_mask_png,
    zarr_source,
)

CODE_MIN, CODE_MAX = 16, 235  # legal limited-range luma
P99_CODE_ERROR_LIMIT = 8
DOMAIN_SAMPLE_FRAMES = 24
COLOR = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]


# ── shared vector helpers (also used by vector_lab.py) ─────────────────

def block_mean(a: np.ndarray, factor: int) -> np.ndarray:
    """NaN-aware block average; a block is valid when most of its cells are."""
    h, w = (a.shape[0] // factor) * factor, (a.shape[1] // factor) * factor
    b = a[:h, :w].reshape(h // factor, factor, w // factor, factor)
    valid = np.isfinite(b)
    count = valid.sum(axis=(1, 3))
    total = np.where(valid, b, 0).sum(axis=(1, 3))
    return np.where(count * 2 > factor * factor, total / np.maximum(count, 1), np.nan).astype(np.float32)


def block_centers(values: np.ndarray, factor: int) -> np.ndarray:
    n = (len(values) // factor) * factor
    return values[:n].reshape(-1, factor).mean(axis=1)


def derive_uv(direction: np.ndarray, magnitude: np.ndarray, derivation: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Same convention as src/lib/vector-derivation.ts."""
    offset = 180.0 if derivation["direction_convention"] != derivation["output_direction"] else 0.0
    radians = np.deg2rad(direction + offset)
    return (magnitude * np.sin(radians)).astype(np.float32), (magnitude * np.cos(radians)).astype(np.float32)


def encode_values(x: np.ndarray, domain: float, transfer: str) -> np.ndarray:
    s = np.clip(x / domain, -1, 1)
    if transfer == "sqrt":
        s = np.sign(s) * np.sqrt(np.abs(s))
    return np.rint(CODE_MIN + (s + 1) / 2 * (CODE_MAX - CODE_MIN)).astype(np.uint8)


def decode_values(code: np.ndarray, domain: float, transfer: str) -> np.ndarray:
    s = np.clip((code.astype(np.float32) - CODE_MIN) / (CODE_MAX - CODE_MIN) * 2 - 1, -1, 1)
    if transfer == "sqrt":
        s = np.sign(s) * s * s
    return s * domain


def luma_frame(u: np.ndarray, v: np.ndarray, static_valid: np.ndarray, domain: float, transfer: str) -> np.ndarray:
    """Stacked u/v codes. Cells invalid in this frame but inside the static mask encode a calm (zero)
    vector; cells outside the mask are padded from neighbors to limit codec ringing at coasts."""
    frame_valid = np.isfinite(u) & np.isfinite(v)
    calm = static_valid & ~frame_valid
    u = np.where(calm, 0, u)
    v = np.where(calm, 0, v)
    known = frame_valid | calm
    cu = encode_values(fill_invalid_for_video(u, known), domain, transfer)
    cv = encode_values(fill_invalid_for_video(v, known), domain, transfer)
    return np.vstack([cu, cv])


def ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise RuntimeError("ffmpeg is required but was not found in PATH")
    return path


def h264_args(crf: int, gop: int, threads: int | None = None) -> list[str]:
    """H.264 High profile, level 4.1: hardware decoding on iOS Safari, Android and desktop."""
    return ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-level:v", "4.1",
            "-crf", str(crf), "-g", str(gop), *(["-threads", str(int(threads))] if threads else [])]


def open_encoder(path: Path, width: int, height: int, fps: float, codec: list[str]) -> subprocess.Popen:
    """Codes go straight into Y (U=V=128); the declared input range prevents any range conversion."""
    return subprocess.Popen(
        [ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p",
         "-color_range", "tv", "-colorspace", "bt709", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
         "-an", *codec, "-pix_fmt", "yuv420p", *COLOR, "-movflags", "+faststart", str(path)],
        stdin=subprocess.PIPE)


def write_frame(encoder: subprocess.Popen, frame: np.ndarray) -> None:
    h, w = frame.shape
    assert encoder.stdin is not None
    encoder.stdin.write(frame.tobytes() + np.full((h // 2) * (w // 2) * 2, 128, np.uint8).tobytes())


def decode_video(path: Path, height: int, width: int) -> Iterator[np.ndarray]:
    """Yield decoded luma planes, frame by frame."""
    process = subprocess.Popen(
        [ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"],
        stdout=subprocess.PIPE)
    assert process.stdout is not None
    size = height * width * 3 // 2
    try:
        while payload := process.stdout.read(size):
            if len(payload) != size:
                raise RuntimeError("Truncated frame while decoding vector GeoVideo")
            yield np.frombuffer(payload, np.uint8)[: height * width].reshape(height, width)
    finally:
        process.stdout.close()
        if process.wait() != 0:
            raise RuntimeError("ffmpeg failed while decoding vector GeoVideo")


# ── configuration ───────────────────────────────────────────────────────

def load_vector_layer(layer_id: str) -> dict[str, Any]:
    catalog = json.loads(CATALOG_PATH.read_text())
    for layer in catalog["layers"]:
        if layer["id"] == layer_id:
            if layer["kind"] != "vector":
                raise ValueError("Vector GeoVideo renderer supports vector layers only")
            return layer
    raise ValueError(f"Unknown catalog layer: {layer_id}")


def parse_step(value: str | None) -> np.timedelta64 | None:
    if value is None:
        return None
    units = {"H": "h", "D": "D"}
    if not value.startswith("PT") and not value.startswith("P"):
        raise ValueError("step must be an ISO 8601 duration such as PT3H or P1D")
    body = value[2:] if value.startswith("PT") else value[1:]
    if not body or body[-1] not in units or not body[:-1].isdigit():
        raise ValueError("step supports whole hours (PTnH) or days (PnD)")
    return np.timedelta64(int(body[:-1]), units[body[-1]])


def validate_config(raw: dict[str, Any], layer: dict[str, Any]) -> dict[str, Any]:
    config_id = uuid4(required(raw, "id"), "id")
    entry_id = uuid4(required(raw, "catalogEntryId"), "catalogEntryId")
    start, end = parse_iso(str(required(raw, "dateStart"))), parse_iso(str(required(raw, "dateEnd")))
    if end <= start:
        raise ValueError("dateEnd must follow dateStart")
    step = raw.get("step")
    parse_step(step)
    output = raw.get("output", {})
    factor = int(output.get("factor", 3))
    crf = int(output.get("crf", 14))
    gop = int(output.get("gop", 12))
    fps = float(output.get("fps", 4))
    transfer = str(output.get("transfer", "sqrt"))
    domain_percentile = float(output.get("domainPercentile", 99.9))
    if not 0 < domain_percentile <= 100:
        raise ValueError("output.domainPercentile must be within (0, 100]")
    fixed_domain = output.get("valueDomain")
    if fixed_domain is not None and (isinstance(fixed_domain, bool) or not isinstance(fixed_domain, (int, float))
                                     or not math.isfinite(fixed_domain) or fixed_domain <= 0):
        raise ValueError("output.valueDomain must be a positive number")
    times = raw.get("times")
    if times is not None:
        if not isinstance(times, list) or len(times) < 2:
            raise ValueError("times must list at least two exact source timestamps")
        parsed = [parse_iso(str(value)) for value in times]
        if any(later <= earlier for earlier, later in zip(parsed, parsed[1:])):
            raise ValueError("times must be strictly increasing")
        if not (start <= parsed[0] and parsed[-1] <= end):
            raise ValueError("times must lie within dateStart/dateEnd")
    if factor < 1 or not 0 <= crf <= 51 or gop < 1 or fps <= 0 or transfer not in {"linear", "sqrt"}:
        raise ValueError("Invalid output settings")
    bounds = raw.get("bounds")
    if bounds is not None:
        if not isinstance(bounds, list) or len(bounds) != 4:
            raise ValueError("bounds must be [west, south, east, north]")
        west, south, east, north = map(float, bounds)
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError("bounds must be within [-180, -90, 180, 90] without crossing the antimeridian")
        bounds = [west, south, east, north]
    palette = (layer.get("defaults") or {}).get("palette")
    if not isinstance(palette, str) or not palette:
        raise ValueError("Vector GeoVideo catalog entry requires defaults.palette")
    return {
        **raw,
        "id": config_id,
        "catalogEntryId": entry_id,
        "step": step,
        **({"bounds": bounds} if bounds else {}),
        "output": {**output, "factor": factor, "crf": crf, "gop": gop, "fps": fps, "transfer": transfer,
                   "directory": str(output.get("directory", "artifacts/geovideo"))},
        "upload": raw.get("upload", {"prefix": "geovideo"}),
    }


def artifact_hash(config: dict[str, Any], layer: dict[str, Any]) -> str:
    material = {
        "format": "geovideo-v3-vector-luma-stacked-uv",
        "config": config,
        "provenance": zarr_source(layer).get("provenance"),
        "store": zarr_source(layer)["endpoints"]["field"],
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:12]


# ── source frames ───────────────────────────────────────────────────────

def crop(dataset: Any, bounds: list[float], factor: int) -> Any:
    """Regional subset, trimmed so the block-averaged grid has even dimensions.
    Only the Zarr chunks intersecting the region are read afterwards."""
    west, south, east, north = bounds
    selection = {}
    for dim, low, high in (("latitude", south, north), ("longitude", west, east)):
        values = dataset[dim].values
        inside = np.nonzero((values >= low) & (values <= high))[0]
        count = len(inside) - len(inside) % (2 * factor)
        if count < 2 * factor:
            raise ValueError(f"bounds select too few {dim} cells")
        selection[dim] = slice(int(inside[0]), int(inside[0]) + count)
    return dataset.isel(selection)


class VectorFrames:
    """Native time steps of a catalog vector source on a block-averaged, north-up grid."""

    def __init__(self, layer: dict[str, Any], config: dict[str, Any]):
        source = zarr_source(layer)
        self.variables = source["variables"]
        self.factor = config["output"]["factor"]
        dataset = open_arco_zarr(source["endpoints"]["field"])
        for dim in list(dataset.dims):
            if dim not in {"time", "latitude", "longitude"}:
                dataset = dataset.isel({dim: surface_index(dataset, dim)})
        if config.get("bounds"):
            dataset = crop(dataset, config["bounds"], self.factor)
        self.dataset = dataset
        times = dataset["time"].values.astype("datetime64[ns]")
        start, end = parse_iso(config["dateStart"]), parse_iso(config["dateEnd"])
        selected = np.nonzero((times >= start) & (times <= end))[0]
        step = parse_step(config.get("step"))
        if config.get("times") is not None:
            wanted = np.array([parse_iso(str(value)) for value in config["times"]], dtype="datetime64[ns]")
            selected = np.nonzero(np.isin(times, wanted))[0]
            if len(selected) != len(wanted):
                raise ValueError("times are not all exact source timestamps")
        elif step is not None:
            keep, next_time = [], None
            for index in selected:
                if next_time is None or times[index] >= next_time:
                    keep.append(index)
                    next_time = times[index] + step
            selected = np.array(keep, dtype=int)
        if len(selected) < 2:
            raise ValueError(f"Requested period selects {len(selected)} time step(s); dataset covers "
                             f"{times.min()} to {times.max()}")
        self.indices = selected
        self.times = times[selected]
        latitude = dataset["latitude"].values.astype(np.float64)
        self.flip = latitude[0] < latitude[-1]
        latitude = latitude[::-1] if self.flip else latitude
        longitude = dataset["longitude"].values.astype(np.float64)
        self.latitude = block_centers(latitude, self.factor)
        self.longitude = block_centers(longitude, self.factor)
        self.height, self.width = len(self.latitude), len(self.longitude)
        if self.height % 2 or self.width % 2:
            raise ValueError(f"Output grid {self.width}x{self.height} must be even; adjust output.factor")
        dy = abs(latitude[1] - latitude[0]) * self.factor
        dx = abs(longitude[1] - longitude[0]) * self.factor
        # Cell edges; the polar row center can sit within half a cell of the pole.
        self.bounds = [round(float(self.longitude[0] - dx / 2), 6),
                       round(max(-90.0, float(self.latitude[-1] - dy / 2)), 6),
                       round(float(self.longitude[-1] + dx / 2), 6),
                       round(min(90.0, float(self.latitude[0] + dy / 2)), 6)]
        self.unit = self._unit()

    def _unit(self) -> str:
        name = self.variables.get("u") or (self.variables.get("derivation") or {}).get("magnitude_variable")
        return str(self.dataset[name].attrs.get("units", "")) if name else ""

    def source_variables(self) -> list[str]:
        derivation = self.variables.get("derivation")
        if derivation:
            return [derivation["direction_variable"], derivation["magnitude_variable"]]
        return [self.variables.get("u", "uo"), self.variables.get("v", "vo")]

    def _read(self, name: str, index: int) -> np.ndarray:
        for attempt in range(5):
            try:
                return np.asarray(self.dataset[name].isel(time=int(index)).values, np.float32)
            except Exception as exc:  # network hiccups on large public stores
                if attempt == 4:
                    raise
                delay = 2 ** attempt
                print(f"Zarr read failed for {name}[{index}], retrying in {delay}s: {exc}", file=sys.stderr)
                time.sleep(delay)
        raise AssertionError("unreachable")

    def frame(self, position: int) -> tuple[np.ndarray, np.ndarray]:
        index = self.indices[position]
        derivation = self.variables.get("derivation")
        if derivation:
            u, v = derive_uv(self._read(derivation["direction_variable"], index),
                             self._read(derivation["magnitude_variable"], index), derivation)
        else:
            u, v = self._read(self.variables.get("u", "uo"), index), self._read(self.variables.get("v", "vo"), index)
        if self.flip:
            u, v = u[::-1], v[::-1]
        return block_mean(u, self.factor), block_mean(v, self.factor)


def value_domain(frames: VectorFrames, percentile: float = 99.9) -> tuple[float, np.ndarray]:
    """Percentile of |u|,|v| over a spread sample of frames, rounded up to 2 significant digits,
    plus the static validity mask (cells valid in any sampled frame). Use 100 when rare extremes
    (a cyclone eye) are the subject; the sqrt transfer keeps slow flows precise either way."""
    positions = np.unique(np.linspace(0, len(frames.times) - 1, min(DOMAIN_SAMPLE_FRAMES, len(frames.times))).round())
    components, valid = [], np.zeros((frames.height, frames.width), bool)
    for position in positions.astype(int):
        u, v = frames.frame(position)
        ok = np.isfinite(u) & np.isfinite(v)
        valid |= ok
        components.append(np.abs(np.concatenate([u[ok], v[ok]])))
    raw = float(np.percentile(np.concatenate(components), percentile))
    if not math.isfinite(raw) or raw <= 0:
        raise ValueError("Cannot derive a positive vector value domain")
    magnitude = 10 ** math.floor(math.log10(raw))
    return round(math.ceil(raw / magnitude * 10) / 10 * magnitude, 12), valid


# ── render ──────────────────────────────────────────────────────────────

def create_manifest(config: dict[str, Any], layer: dict[str, Any], frames: VectorFrames, domain: float) -> dict[str, Any]:
    source = zarr_source(layer)
    fps = config["output"]["fps"]
    return {
        "schemaVersion": 3,
        "id": config["id"],
        "type": "geovideo",
        "projection": "equirectangular",
        "bounds": frames.bounds,
        "media": {"url": "video.mp4", "mimeType": "video/mp4", "width": frames.width, "height": frames.height * 2,
                  "fps": fps, "durationSeconds": len(frames.times) / fps, "codec": "h264"},
        "encoding": {"kind": "vector-luma", "bits": 8, "codeMin": CODE_MIN, "codeMax": CODE_MAX,
                     "valueDomain": domain, "transfer": config["output"]["transfer"], "layout": "stacked-uv",
                     "colorSpace": "bt709", "colorRange": "limited"},
        "mask": {"kind": "static-validity", "url": "mask.png", "mimeType": "image/png",
                 "width": frames.width, "height": frames.height, "threshold": 0.5},
        "timeline": {"kind": "sample-sequence",
                     "values": [np.datetime_as_string(t, unit="s") + "Z" for t in frames.times]},
        "provenance": {
            "catalogEntryId": layer["id"],
            "inputSourceId": source["id"],
            "provider": source.get("provenance", {}).get("provider"),
            "identifiers": source.get("provenance", {}).get("identifiers", {}),
            "variables": frames.source_variables(),
            "generatedAt": np.datetime_as_string(np.datetime64("now", "s"), timezone="UTC"),
        },
        # Particle shaders normalize speed by |(d, d)| for a fixed domain d.
        "style": {"palette": layer["defaults"]["palette"], "colorDomain": [0, domain * math.sqrt(2)],
                  "unit": frames.unit},
    }


def render(config: dict[str, Any], layer: dict[str, Any], directory: Path, max_frames: int | None) -> dict[str, Any]:
    frames = VectorFrames(layer, config)
    if max_frames:
        frames.indices, frames.times = frames.indices[:max_frames], frames.times[:max_frames]
    count = len(frames.times)
    print(f"{count} frames {frames.times[0]} -> {frames.times[-1]}, grid {frames.width}x{frames.height}", flush=True)
    domain, static_valid = value_domain(frames, float(config["output"].get("domainPercentile", 99.9)))
    if config["output"].get("valueDomain") is not None:
        domain = float(config["output"]["valueDomain"])
    transfer = config["output"]["transfer"]
    print(f"value domain ±{domain} {frames.unit}", flush=True)
    directory.mkdir(parents=True, exist_ok=True)
    video = directory / "video.mp4"
    encoder = open_encoder(video, frames.width, frames.height * 2, config["output"]["fps"],
                           h264_args(config["output"]["crf"], config["output"]["gop"],
                                     config["output"].get("threads")))
    check_every = max(1, count // 16)
    expected: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    empty_samples: list[str] = []
    tic = time.time()
    try:
        for position in range(count):
            u, v = frames.frame(position)
            if not (np.isfinite(u) & np.isfinite(v)).any():
                empty_samples.append(sample_iso(frames.times[position]))
            codes = luma_frame(u, v, static_valid, domain, transfer)
            write_frame(encoder, codes)
            if position % check_every == 0:
                expected[position] = (codes, np.vstack([static_valid, static_valid]))
            if position % 10 == 0:
                print(f"  frame {position + 1}/{count} ({time.time() - tic:.0f}s)", flush=True)
    finally:
        assert encoder.stdin is not None
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise RuntimeError("ffmpeg failed while encoding vector GeoVideo")
    if empty_samples:
        raise EmptySamplesError(empty_samples)
    errors = []
    for position, decoded in enumerate(decode_video(video, frames.height * 2, frames.width)):
        if position in expected:
            codes, valid = expected[position]
            errors.append(np.abs(decoded.astype(np.int16) - codes.astype(np.int16))[valid])
    combined = np.concatenate(errors)
    report = {"samples": int(combined.size), "meanAbsoluteCodeError": float(combined.mean()),
              "p99AbsoluteCodeError": int(np.percentile(combined, 99, method="higher")),
              "maxAbsoluteCodeError": int(combined.max()), "limits": {"p99AbsoluteCodeError": P99_CODE_ERROR_LIMIT}}
    (directory / "validation.json").write_text(json.dumps(report, indent=2))
    if report["p99AbsoluteCodeError"] > P99_CODE_ERROR_LIMIT:
        raise RuntimeError(f"Vector GeoVideo exceeds its code error budget: {report}")
    write_mask_png(directory / "mask.png", static_valid)
    manifest = create_manifest(config, layer, frames, domain)
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
    size = video.stat().st_size
    print(f"video {size / 1e6:.1f} MB ({size / count / 1e3:.0f} kB/frame), validation {report}", flush=True)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("config", type=Path)
    parser.add_argument("--dry-run", action="store_true", help="Resolve the configuration and time steps only")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--upload-only", action="store_true", help="Publish an already generated artifact")
    parser.add_argument("--max-frames", type=int, help="Render only the first N frames for smoke tests")
    args = parser.parse_args()

    raw = json.loads(args.config.read_text())
    layer = load_vector_layer(str(required(raw, "catalogEntryId")))
    config = validate_config(raw, layer)
    artifact_id = artifact_hash(config, layer)
    root = Path(config["output"]["directory"])
    directory = (root if root.is_absolute() else ROOT / root) / f"{config['catalogEntryId']}-{artifact_id}"
    if args.dry_run:
        frames = VectorFrames(layer, config)
        print(json.dumps({"directory": str(directory.relative_to(ROOT)), "frames": len(frames.times),
                          "first": str(frames.times[0]), "last": str(frames.times[-1]),
                          "grid": [frames.width, frames.height], "bounds": frames.bounds, "unit": frames.unit},
                         indent=2))
        return 0
    if not args.upload_only:
        render(config, layer, directory, args.max_frames)
    if args.upload or args.upload_only:
        if args.max_frames:
            raise ValueError("Refusing to publish a --max-frames smoke artifact")
        print(f"published {publish(directory, config, artifact_id)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
