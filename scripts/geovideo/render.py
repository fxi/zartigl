#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.35",
#   "fsspec>=2025.3",
#   "numpy>=2.0",
#   "requests>=2.32",
#   "s3fs>=2025.3",
#   "xarray>=2025.1",
#   "zarr>=2.18,<3",
# ]
# ///
"""Generate and optionally publish a scalar GeoVideo artifact.

Usage:
  uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json
  uv run scripts/geovideo/render.py config.json --upload
  uv run scripts/geovideo/render.py config.json --dry-run
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time
from typing import Any
import zlib

import numpy as np
import requests
import xarray as xr

ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = ROOT / "src" / "catalog" / "catalog.json"
P99_CODE_ERROR_LIMIT = 8
MAX_CODE_ERROR_LIMIT = 16


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def required(config: dict[str, Any], key: str) -> Any:
    if key not in config:
        raise ValueError(f"Missing configuration field: {key}")
    return config[key]


def parse_iso(value: str) -> np.datetime64:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        utc_naive = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return np.datetime64(utc_naive, "ns")
    except Exception as exc:
        raise ValueError(f"Invalid ISO date: {value}") from exc


def load_layer(layer_id: str) -> dict[str, Any]:
    catalog = json.loads(CATALOG_PATH.read_text())
    for layer in catalog["layers"]:
        if layer["id"] == layer_id:
            if layer["kind"] != "scalar":
                raise ValueError("GeoVideo renderer supports scalar layers only")
            return layer
    raise ValueError(f"Unknown catalog layer: {layer_id}")


def validate_config(raw: dict[str, Any]) -> dict[str, Any]:
    layer_id = str(required(raw, "layerId"))
    sampling = raw.get("sampling")
    if sampling is None:
        start = str(required(raw, "dateStart"))
        end = str(required(raw, "dateEnd"))
        start_ns = parse_iso(start)
        end_ns = parse_iso(end)
        if end_ns <= start_ns:
            raise ValueError("dateEnd must follow dateStart")
        duration = float(required(raw, "durationSeconds"))
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("durationSeconds must be a finite positive number")
    else:
        if not isinstance(sampling, dict) or sampling.get("kind") not in {"annual-month", "monthly"}:
            raise ValueError("sampling.kind must be annual-month or monthly")
        if sampling["kind"] == "annual-month":
            month = int(required(sampling, "month"))
            year_start = int(required(sampling, "yearStart"))
            year_end = int(required(sampling, "yearEnd"))
            seconds_per_sample = float(sampling.get("secondsPerSample", 1))
            if not 1 <= month <= 12 or year_end < year_start:
                raise ValueError("Invalid annual-month sampling range")
            if not math.isfinite(seconds_per_sample) or seconds_per_sample <= 0:
                raise ValueError("sampling.secondsPerSample must be positive")
            sampling = {
                **sampling,
                "month": month,
                "yearStart": year_start,
                "yearEnd": year_end,
                "secondsPerSample": seconds_per_sample,
            }
        else:
            sample_start = str(required(sampling, "dateStart"))
            sample_end = str(required(sampling, "dateEnd"))
            sample_count = monthly_sample_count(sample_start, sample_end)
            raw_frames_per_sample = sampling.get("framesPerSample", 1)
            if (
                isinstance(raw_frames_per_sample, bool)
                or not isinstance(raw_frames_per_sample, int)
                or raw_frames_per_sample < 1
            ):
                raise ValueError("sampling.framesPerSample must be a positive integer")
            frames_per_sample = raw_frames_per_sample
            sampling = {
                **sampling,
                "dateStart": sample_start,
                "dateEnd": sample_end,
                "sampleCount": sample_count,
                "framesPerSample": frames_per_sample,
            }
        start = end = None
        duration = 0
    interpolation = raw.get("interpolation", "linear")
    if interpolation not in {"linear", "nearest"}:
        raise ValueError("interpolation must be linear or nearest")
    bounds = raw.get("bounds", [-180, -90, 180, 90])
    if not isinstance(bounds, list) or len(bounds) != 4:
        raise ValueError("bounds must be [west, south, east, north]")
    west, south, east, north = map(float, bounds)
    if not (-90 <= south < north <= 90) or west == east:
        raise ValueError("Invalid geographic bounds")
    output = raw.get("output", {})
    width = int(output.get("width", 2048))
    height = int(output.get("height", 1024))
    fps = float(output.get("fps", 24))
    crf = int(output.get("crf", 12))
    max_bitrate = str(output.get("maxBitrate", "16M"))
    preset = str(output.get("preset", "fast"))
    if preset not in {"medium", "fast", "faster", "veryfast"}:
        raise ValueError("output.preset must be medium, fast, faster, or veryfast")
    if width < 2 or height < 2 or width % 2 or height % 2 or fps <= 0:
        raise ValueError("Output width/height must be positive even numbers and fps must be positive")
    if not 0 <= crf <= 51:
        raise ValueError("output.crf must be within [0, 51]")
    if sampling is not None:
        frames_per_sample = sampling.get("framesPerSample")
        if frames_per_sample is None:
            frames_per_sample = round(sampling["secondsPerSample"] * fps)
        if frames_per_sample < 1:
            raise ValueError("sampling.secondsPerSample must encode at least one frame")
        sampling["framesPerSample"] = frames_per_sample
        sample_count = sampling.get("sampleCount", sampling.get("yearEnd", 0) - sampling.get("yearStart", 0) + 1)
        duration = sample_count * frames_per_sample / fps
    style = raw.get("style", {})
    domain = style.get("colorDomain")
    if not isinstance(domain, list) or len(domain) != 2 or not float(domain[0]) < float(domain[1]):
        raise ValueError("style.colorDomain must contain an increasing pair")
    result = {
        **raw,
        "layerId": layer_id,
        "durationSeconds": duration,
        "interpolation": interpolation,
        "sampling": sampling,
        "bounds": [west, south, east, north],
        "output": {
            **output,
            "width": width,
            "height": height,
            "fps": fps,
            "crf": crf,
            "maxBitrate": max_bitrate,
            "preset": preset,
            "directory": str(output.get("directory", "artifacts/geovideo")),
        },
        "style": {
            **style,
            "colorDomain": [float(domain[0]), float(domain[1])],
            "palette": str(style.get("palette", "balance")),
            "logScale": bool(style.get("logScale", False)),
            "vibrance": float(style.get("vibrance", 0)),
        },
    }
    if sampling is None:
        result["dateStart"] = start
        result["dateEnd"] = end
    return result


def artifact_hash(config: dict[str, Any], layer: dict[str, Any]) -> str:
    material = {
        "format": "geovideo-v2-scalar-luma-static-mask-intersection-exact-samples-v2",
        "config": config,
        "dataset": layer["dataset"],
        "store": layer["stores"]["field"],
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:12]


def normalize_times(values: np.ndarray) -> np.ndarray:
    try:
        return values.astype("datetime64[ns]")
    except (TypeError, ValueError) as exc:
        raise ValueError("GeoVideo renderer requires a standard decoded datetime time axis") from exc


def monthly_sample_count(start: str, end: str) -> int:
    start_ns = parse_iso(start)
    end_ns = parse_iso(end)
    if end_ns < start_ns:
        raise ValueError("sampling.dateEnd must not precede sampling.dateStart")
    start_month = start_ns.astype("datetime64[M]")
    end_month = end_ns.astype("datetime64[M]")
    return int((end_month - start_month).astype(int)) + 1


def validate_monthly_samples(values: np.ndarray, start: np.datetime64, end: np.datetime64) -> np.ndarray:
    normalized = normalize_times(values)
    expected_months = np.arange(
        start.astype("datetime64[M]"),
        end.astype("datetime64[M]") + np.timedelta64(1, "M"),
        dtype="datetime64[M]",
    )
    found_months = normalized.astype("datetime64[M]")
    if len(normalized) != len(expected_months) or not np.array_equal(found_months, expected_months):
        found = [str(value) for value in found_months]
        raise ValueError(
            "monthly sampling expected exactly one value for every calendar month; "
            f"found months {found}"
        )
    return normalized


class ScalarFrames:
    def __init__(self, layer: dict[str, Any], config: dict[str, Any]):
        self.layer = layer
        self.config = config
        store = layer["stores"]["field"]["url"]
        self.dataset = xr.open_zarr(store, consolidated=True, chunks=None)
        self.variable = layer["variables"]["value"]
        if self.variable not in self.dataset:
            raise ValueError(f"Variable not found in store: {self.variable}")
        self.data = self.dataset[self.variable]
        for dimension in list(self.data.dims):
            if dimension not in {"time", "latitude", "longitude"}:
                self.data = self.data.isel({dimension: 0})
        self.data = self.data.transpose("time", "latitude", "longitude")
        self.times = normalize_times(np.asarray(self.dataset["time"].values))
        self.samples = self._resolve_sample_times()
        if self.samples is None:
            self.start = parse_iso(config["dateStart"])
            self.end = parse_iso(config["dateEnd"])
            if self.start < self.times.min() or self.end > self.times.max():
                raise ValueError(
                    f"Requested range is outside dataset time axis: {self.times.min()} to {self.times.max()}"
                )
        else:
            self.start = self.samples[0]
            self.end = self.samples[-1]
        self.source_lat = np.asarray(self.dataset["latitude"].values, dtype=np.float64)
        self.source_lon = np.asarray(self.dataset["longitude"].values, dtype=np.float64)
        self.cache: dict[int, np.ndarray] = {}
        self._prepare_spatial_indices()

    def _resolve_sample_times(self) -> np.ndarray | None:
        sampling = self.config.get("sampling")
        if sampling is None:
            return None
        timestamps = self.dataset["time"]
        if sampling["kind"] == "monthly":
            start = parse_iso(sampling["dateStart"])
            end = parse_iso(sampling["dateEnd"])
            selected = timestamps.where((timestamps >= start) & (timestamps <= end), drop=True)
            return validate_monthly_samples(np.asarray(selected.values), start, end)
        selected = timestamps.where(
            (timestamps.dt.month == sampling["month"])
            & (timestamps.dt.year >= sampling["yearStart"])
            & (timestamps.dt.year <= sampling["yearEnd"]),
            drop=True,
        )
        values = normalize_times(np.asarray(selected.values))
        expected = sampling["yearEnd"] - sampling["yearStart"] + 1
        years = selected.dt.year.values.astype(int).tolist()
        if len(values) != expected or years != list(range(sampling["yearStart"], sampling["yearEnd"] + 1)):
            raise ValueError(
                f"annual-month sampling expected one value for every year; found years {years}"
            )
        return values

    def _prepare_spatial_indices(self) -> None:
        west, south, raw_east, north = self.config["bounds"]
        east = raw_east + 360 if raw_east < west else raw_east
        width = self.config["output"]["width"]
        height = self.config["output"]["height"]
        lon_step = (east - west) / width
        lat_step = (north - south) / height
        target_lon = west + (np.arange(width) + 0.5) * lon_step
        target_lat = north - (np.arange(height) + 0.5) * lat_step

        source_lon = ((self.source_lon - west) % 360) + west
        lon_order = np.argsort(source_lon)
        source_lon = source_lon[lon_order]
        self.lon_order = lon_order
        if east > source_lon[-1]:
            source_lon = np.concatenate([source_lon, source_lon[:1] + 360])
            self.lon_wrap = True
        else:
            self.lon_wrap = False
        lat_order = np.argsort(self.source_lat)
        source_lat = self.source_lat[lat_order]
        self.lat_order = lat_order
        self.x1 = np.clip(np.searchsorted(source_lon, target_lon), 1, len(source_lon) - 1)
        self.x0 = self.x1 - 1
        self.wx = ((target_lon - source_lon[self.x0]) / (source_lon[self.x1] - source_lon[self.x0]))[None, :]
        self.y1 = np.clip(np.searchsorted(source_lat, target_lat), 1, len(source_lat) - 1)
        self.y0 = self.y1 - 1
        self.wy = ((target_lat - source_lat[self.y0]) / (source_lat[self.y1] - source_lat[self.y0]))[:, None]

    def _slice(self, index: int) -> np.ndarray:
        cached = self.cache.get(index)
        if cached is not None:
            return cached
        for attempt in range(5):
            try:
                raw = np.asarray(self.data.isel(time=index).values, dtype=np.float32)
                break
            except Exception as exc:
                if attempt == 4:
                    raise
                delay = 2 ** attempt
                print(
                    f"Zarr read failed for source time index {index}; retrying in {delay}s "
                    f"({attempt + 1}/5): {exc}",
                    file=sys.stderr,
                )
                time.sleep(delay)
        raw = raw[self.lat_order, :][:, self.lon_order]
        if self.lon_wrap:
            raw = np.concatenate([raw, raw[:, :1]], axis=1)
        a = raw[self.y0[:, None], self.x0[None, :]]
        b = raw[self.y0[:, None], self.x1[None, :]]
        c = raw[self.y1[:, None], self.x0[None, :]]
        d = raw[self.y1[:, None], self.x1[None, :]]
        weights = [
            (1 - self.wy) * (1 - self.wx),
            (1 - self.wy) * self.wx,
            self.wy * (1 - self.wx),
            self.wy * self.wx,
        ]
        values = [a, b, c, d]
        valid_weight = np.zeros(a.shape, dtype=np.float32)
        result = np.zeros(a.shape, dtype=np.float32)
        for value, weight in zip(values, weights, strict=True):
            valid = np.isfinite(value)
            result += np.where(valid, value, 0) * weight
            valid_weight += valid * weight
        result = np.divide(result, valid_weight, out=np.full_like(result, np.nan), where=valid_weight >= 0.5)
        self.cache[index] = result
        while len(self.cache) > 2:
            del self.cache[next(iter(self.cache))]
        return result

    def _frame_at(self, target: np.datetime64) -> np.ndarray:
        upper = int(np.searchsorted(self.times, target, side="left"))
        upper = min(max(upper, 0), len(self.times) - 1)
        if self.times[upper] == target:
            return self._slice(upper)
        lower = max(0, upper - 1)
        if self.config["interpolation"] == "nearest":
            chosen = lower if target - self.times[lower] <= self.times[upper] - target else upper
            return self._slice(chosen)
        if lower == upper:
            return self._slice(lower)
        span = (self.times[upper] - self.times[lower]).astype("timedelta64[ns]").astype(np.int64)
        elapsed = (target - self.times[lower]).astype("timedelta64[ns]").astype(np.int64)
        weight = float(elapsed / span)
        first = self._slice(lower)
        second = self._slice(upper)
        valid = np.isfinite(first) & np.isfinite(second)
        return np.where(valid, first * (1 - weight) + second * weight, np.nan)

    def frame(self, index: int, count: int) -> np.ndarray:
        if self.samples is not None:
            frames_per_sample = self.config["sampling"]["framesPerSample"]
            sample_index = min(len(self.samples) - 1, index // frames_per_sample)
            return self._frame_at(self.samples[sample_index])
        fraction = index / max(1, count - 1)
        return self._frame_at(self.start + (self.end - self.start) * fraction)


def fill_invalid_for_video(values: np.ndarray, valid: np.ndarray, passes: int = 8) -> np.ndarray:
    """Extend nearby ocean values under the mask to limit codec ringing at coasts."""
    result = np.where(valid, values, 0).astype(np.float32)
    known = valid.copy()
    for _ in range(passes):
        total = np.zeros_like(result)
        count = np.zeros(result.shape, dtype=np.uint8)
        for shifted_values, shifted_known in (
            (np.roll(result, 1, axis=1), np.roll(known, 1, axis=1)),
            (np.roll(result, -1, axis=1), np.roll(known, -1, axis=1)),
            (np.vstack([result[:1], result[:-1]]), np.vstack([known[:1], known[:-1]])),
            (np.vstack([result[1:], result[-1:]]), np.vstack([known[1:], known[-1:]])),
        ):
            total += np.where(shifted_known, shifted_values, 0)
            count += shifted_known
        target = ~known & (count > 0)
        if not np.any(target):
            break
        result[target] = total[target] / count[target]
        known[target] = True
    fallback = float(np.mean(values[valid])) if np.any(valid) else 0.0
    result[~known] = fallback
    return result


def render_scalar_luma(values: np.ndarray, config: dict[str, Any]) -> np.ndarray:
    minimum, maximum = config["style"]["colorDomain"]
    valid = np.isfinite(values)
    filled = fill_invalid_for_video(values, valid)
    normalized = np.clip((filled - minimum) / (maximum - minimum), 0, 1)
    codes = np.rint(8 + normalized * (247 - 8)).astype(np.uint8)
    return np.repeat(codes[:, :, None], 3, axis=2)


def write_mask_png(path: Path, valid: np.ndarray) -> None:
    """Write an 8-bit grayscale PNG using only the Python standard library."""
    height, width = valid.shape
    pixels = np.where(valid, 255, 0).astype(np.uint8)
    scanlines = b"".join(b"\x00" + pixels[row].tobytes() for row in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(scanlines, level=9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def ffmpeg_command(config: dict[str, Any], output: Path) -> list[str]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required but was not found in PATH")
    width = config["output"]["width"]
    height = config["output"]["height"]
    fps = config["output"]["fps"]
    return [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "warning", "-stats",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an",
        "-c:v", "libx264", "-preset", config["output"]["preset"], "-crf", str(config["output"]["crf"]),
        "-maxrate", config["output"]["maxBitrate"], "-bufsize", "16M",
        "-g", str(max(1, round(fps * 2))), "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-color_range", "tv",
        "-movflags", "+faststart", str(output),
    ]


def probe_media(path: Path, config: dict[str, Any], expected_duration: float) -> dict[str, Any]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe is required but was not found in PATH")
    completed = subprocess.run(
        [
            ffprobe, "-v", "error", "-show_entries",
            "format=duration,size:stream=codec_name,pix_fmt,width,height,r_frame_rate",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    probe = json.loads(completed.stdout)
    stream = probe["streams"][0]
    expected = (config["output"]["width"], config["output"]["height"])
    if stream.get("codec_name") != "h264" or stream.get("pix_fmt") != "yuv420p":
        raise RuntimeError("GeoVideo output must be H.264 yuv420p")
    if (stream.get("width"), stream.get("height")) != expected:
        raise RuntimeError(f"Unexpected GeoVideo dimensions: {stream.get('width')}x{stream.get('height')}")
    numerator, denominator = map(float, stream.get("r_frame_rate", "0/1").split("/"))
    actual_fps = numerator / denominator
    if not math.isclose(actual_fps, config["output"]["fps"], rel_tol=0, abs_tol=0.001):
        raise RuntimeError(f"Unexpected GeoVideo frame rate: {actual_fps}")
    actual_duration = float(probe["format"]["duration"])
    if not math.isclose(actual_duration, expected_duration, rel_tol=0, abs_tol=1 / actual_fps):
        raise RuntimeError(f"Unexpected GeoVideo duration: {actual_duration}")
    with path.open("rb") as handle:
        header = handle.read(1024 * 1024)
    if header.find(b"moov") < 0 or (header.find(b"mdat") >= 0 and header.find(b"moov") > header.find(b"mdat")):
        raise RuntimeError("GeoVideo MP4 is not faststart optimized")
    return probe


def validate_encoded_values(
    path: Path,
    expected_samples: list[tuple[np.ndarray, np.ndarray]],
    width: int,
    height: int,
) -> dict[str, Any]:
    """Decode the artifact and enforce a sampled scalar-code error budget."""
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    process = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    assert process.stdout is not None
    frame_bytes = width * height * 3
    y_stride = max(1, height // 32)
    x_stride = max(1, width // 64)
    errors: list[np.ndarray] = []
    decoded_count = 0
    while True:
        payload = process.stdout.read(frame_bytes)
        if not payload:
            break
        if len(payload) != frame_bytes:
            process.kill()
            raise RuntimeError("Truncated frame while validating scalar-luma video")
        if decoded_count >= len(expected_samples):
            process.kill()
            raise RuntimeError("Scalar-luma video contains more frames than expected")
        rgb = np.frombuffer(payload, dtype=np.uint8).reshape(height, width, 3)
        decoded = np.clip(np.rint(
            rgb[:, :, 0].astype(np.float32) * .2126
            + rgb[:, :, 1].astype(np.float32) * .7152
            + rgb[:, :, 2].astype(np.float32) * .0722
        ), 0, 255).astype(np.uint8)[::y_stride, ::x_stride]
        expected, valid = expected_samples[decoded_count]
        errors.append(np.abs(decoded.astype(np.int16) - expected.astype(np.int16))[valid])
        decoded_count += 1
    if process.wait() != 0:
        raise RuntimeError("FFmpeg failed while validating scalar-luma video")
    if decoded_count != len(expected_samples):
        raise RuntimeError(f"Expected {len(expected_samples)} decoded frames, received {decoded_count}")
    combined = np.concatenate(errors) if errors else np.empty(0, dtype=np.int16)
    if combined.size == 0:
        raise RuntimeError("Scalar-luma validation found no valid samples")
    report = {
        "samples": int(combined.size),
        "meanAbsoluteCodeError": float(np.mean(combined)),
        "p99AbsoluteCodeError": int(np.percentile(combined, 99, method="higher")),
        "maxAbsoluteCodeError": int(np.max(combined)),
        "limits": {
            "p99AbsoluteCodeError": P99_CODE_ERROR_LIMIT,
            "maxAbsoluteCodeError": MAX_CODE_ERROR_LIMIT,
        },
    }
    if (
        report["p99AbsoluteCodeError"] > P99_CODE_ERROR_LIMIT or
        report["maxAbsoluteCodeError"] > MAX_CODE_ERROR_LIMIT
    ):
        raise RuntimeError(f"Scalar-luma artifact exceeds its code error budget: {report}")
    return report


def validate_value_report(report_path: Path) -> dict[str, Any]:
    """Require a successful value-fidelity report before publishing an artifact."""
    if not report_path.exists():
        raise RuntimeError(f"Scalar-luma validation report not found: {report_path}")
    report = json.loads(report_path.read_text())
    validation = report.get("valueValidation")
    if not isinstance(validation, dict):
        raise RuntimeError("Scalar-luma artifact has no valueValidation result")
    limits = validation.get("limits")
    if not isinstance(limits, dict):
        raise RuntimeError("Scalar-luma artifact has no valueValidation limits")
    p99 = validation.get("p99AbsoluteCodeError")
    maximum = validation.get("maxAbsoluteCodeError")
    recorded_p99_limit = limits.get("p99AbsoluteCodeError")
    recorded_maximum_limit = limits.get("maxAbsoluteCodeError")
    if not all(
        isinstance(value, (int, float))
        for value in (p99, maximum, recorded_p99_limit, recorded_maximum_limit)
    ):
        raise RuntimeError("Scalar-luma artifact has an invalid valueValidation result")
    if recorded_p99_limit != P99_CODE_ERROR_LIMIT or recorded_maximum_limit != MAX_CODE_ERROR_LIMIT:
        raise RuntimeError("Scalar-luma artifact was validated against a different error budget")
    if p99 > P99_CODE_ERROR_LIMIT or maximum > MAX_CODE_ERROR_LIMIT:
        raise RuntimeError(f"Scalar-luma artifact exceeds its recorded code error budget: {validation}")
    return report


def create_manifest(
    config: dict[str, Any], layer: dict[str, Any], media_name: str, mask_name: str,
    sample_times: np.ndarray | None = None,
) -> dict[str, Any]:
    width = config["output"]["width"]
    height = config["output"]["height"]
    timeline = {
        "kind": "sample-sequence",
        "values": [
            np.datetime_as_string(value, unit="s", timezone="UTC")
            for value in sample_times
        ],
    } if sample_times is not None else {
        "kind": "range",
        "dateStart": config["dateStart"],
        "dateEnd": config["dateEnd"],
        "interpolation": config["interpolation"],
    }
    return {
        "schemaVersion": 2,
        "id": config.get("id", f"{config['layerId']}-geovideo"),
        "type": "geovideo",
        "projection": "equirectangular",
        "bounds": config["bounds"],
        "media": {
            "url": media_name,
            "mimeType": "video/mp4",
            "width": width,
            "height": height,
            "fps": config["output"]["fps"],
            "durationSeconds": config["durationSeconds"],
            "codec": "h264",
        },
        "encoding": {
            "kind": "scalar-luma",
            "bits": 8,
            "codeMin": 8,
            "codeMax": 247,
            "valueMin": config["style"]["colorDomain"][0],
            "valueMax": config["style"]["colorDomain"][1],
            "transfer": "linear",
            "colorSpace": "bt709",
            "colorRange": "limited",
        },
        "mask": {
            "kind": "static-validity",
            "url": mask_name,
            "mimeType": "image/png",
            "width": width,
            "height": height,
            "threshold": 0.5,
        },
        "timeline": timeline,
        "provenance": {
            "layerId": layer["id"],
            "datasetId": layer["dataset"]["id"],
            "variable": layer["variables"]["value"],
            "generatedAt": np.datetime_as_string(np.datetime64("now", "s"), timezone="UTC"),
        },
        "style": {
            "palette": config["style"]["palette"],
            "colorDomain": config["style"]["colorDomain"],
            "unit": config["style"].get("unit", ""),
            "logScale": config["style"]["logScale"],
            "vibrance": config["style"]["vibrance"],
        },
    }


def publish(directory: Path, config: dict[str, Any], artifact_id: str) -> str:
    import boto3

    env = {**read_dotenv(ROOT / ".env.demo"), **read_dotenv(ROOT / ".env"), **os.environ}
    required_names = ["S3_ENDPOINT", "S3_KEY", "S3_SECRET", "S3_BUCKET"]
    missing = [name for name in required_names if not env.get(name)]
    if missing:
        raise RuntimeError(f"Missing S3 configuration: {', '.join(missing)}")
    client = boto3.client(
        "s3",
        endpoint_url=env["S3_ENDPOINT"],
        aws_access_key_id=env["S3_KEY"],
        aws_secret_access_key=env["S3_SECRET"],
    )
    client.put_bucket_cors(
        Bucket=env["S3_BUCKET"],
        CORSConfiguration={
            "CORSRules": [{
                "AllowedMethods": ["GET", "HEAD"],
                "AllowedOrigins": ["*"],
                "AllowedHeaders": ["Range"],
                "ExposeHeaders": ["Accept-Ranges", "Content-Length", "Content-Range", "ETag"],
                "MaxAgeSeconds": 86400,
            }],
        },
    )
    prefix = config.get("upload", {}).get("prefix", "geovideo")
    object_prefix = f"{prefix.strip('/')}/{config['layerId']}/{artifact_id}"
    media = directory / "video.mp4"
    mask = directory / "mask.png"
    manifest = directory / "manifest.json"
    client.upload_file(
        str(media), env["S3_BUCKET"], f"{object_prefix}/video.mp4",
        ExtraArgs={
            "ACL": "public-read",
            "ContentType": "video/mp4",
            "CacheControl": "public,max-age=31536000,immutable",
        },
    )
    client.upload_file(
        str(mask), env["S3_BUCKET"], f"{object_prefix}/mask.png",
        ExtraArgs={
            "ACL": "public-read",
            "ContentType": "image/png",
            "CacheControl": "public,max-age=31536000,immutable",
        },
    )
    client.upload_file(
        str(manifest), env["S3_BUCKET"], f"{object_prefix}/manifest.json",
        ExtraArgs={
            "ACL": "public-read",
            "ContentType": "application/json",
            "CacheControl": "public,max-age=31536000,immutable",
        },
    )
    configured_base = config.get("upload", {}).get("publicBaseUrl")
    endpoint = env["S3_ENDPOINT"].rstrip("/")
    candidates = [configured_base] if configured_base else [
        f"{endpoint}/{env['S3_BUCKET']}",
        endpoint.replace("://", f"://{env['S3_BUCKET']}.", 1),
    ]
    errors = []
    for public_base in candidates:
        manifest_url = f"{public_base.rstrip('/')}/{object_prefix}/manifest.json"
        try:
            manifest_response = requests.get(
                manifest_url,
                headers={"Origin": "https://example.org"},
                timeout=20,
            )
            manifest_response.raise_for_status()
            if "access-control-allow-origin" not in manifest_response.headers:
                raise RuntimeError("S3 manifest response does not advertise CORS")
            video_url = f"{public_base.rstrip('/')}/{object_prefix}/video.mp4"
            video_response = requests.get(
                video_url,
                headers={"Range": "bytes=0-1", "Origin": "https://example.org"},
                timeout=20,
                stream=True,
            )
            video_response.raise_for_status()
            if video_response.status_code != 206:
                raise RuntimeError(f"unexpected range status {video_response.status_code}")
            if "access-control-allow-origin" not in video_response.headers:
                raise RuntimeError("S3 video response does not advertise CORS")
            video_response.close()
            mask_url = f"{public_base.rstrip('/')}/{object_prefix}/mask.png"
            mask_response = requests.get(mask_url, headers={"Origin": "https://example.org"}, timeout=20)
            mask_response.raise_for_status()
            if mask_response.headers.get("content-type", "").split(";", 1)[0] != "image/png":
                raise RuntimeError("S3 mask response is not image/png")
            if "access-control-allow-origin" not in mask_response.headers:
                raise RuntimeError("S3 mask response does not advertise CORS")
            mask_response.close()
            return manifest_url
        except Exception as exc:
            errors.append(f"{manifest_url}: {exc}")
    raise RuntimeError("Published objects are not browser-readable: " + "; ".join(errors))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--upload-only", action="store_true", help="Publish an already generated artifact")
    parser.add_argument("--max-frames", type=int, help="Render only the first N frames for smoke tests")
    args = parser.parse_args()

    config = validate_config(json.loads(args.config.read_text()))
    layer = load_layer(config["layerId"])
    artifact_id = artifact_hash(config, layer)
    output_root = Path(config["output"]["directory"])
    if not output_root.is_absolute():
        output_root = ROOT / output_root
    directory = output_root / f"{config['layerId']}-{artifact_id}"
    frame_count = round(config["durationSeconds"] * config["output"]["fps"])
    if args.max_frames is not None:
        frame_count = min(frame_count, max(1, args.max_frames))
    summary = {
        "artifactId": artifact_id,
        "directory": str(directory),
        "frames": frame_count,
        "mediaSize": [config["output"]["width"], config["output"]["height"]],
        "estimatedRawBytes": frame_count * config["output"]["width"] * config["output"]["height"] * 3,
    }
    print(json.dumps(summary, indent=2))
    if args.dry_run:
        return 0

    if args.upload_only:
        video_path = directory / "video.mp4"
        mask_path = directory / "mask.png"
        manifest_path = directory / "manifest.json"
        report_path = directory / "report.json"
        if not video_path.exists() or not mask_path.exists() or not manifest_path.exists():
            raise RuntimeError(f"Generated artifact not found: {directory}")
        probe_media(video_path, config, config["durationSeconds"])
        validate_value_report(report_path)
        url = publish(directory, config, artifact_id)
        print(json.dumps({"manifestUrl": url}, indent=2))
        return 0

    directory.mkdir(parents=True, exist_ok=True)
    video_path = directory / "video.mp4"
    mask_path = directory / "mask.png"
    frames = ScalarFrames(layer, config)
    command = ffmpeg_command(config, video_path)
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    static_mask: np.ndarray | None = None
    union_mask: np.ndarray | None = None
    expected_samples: list[tuple[np.ndarray, np.ndarray]] = []
    y_stride = max(1, config["output"]["height"] // 32)
    x_stride = max(1, config["output"]["width"] // 64)
    try:
        assert process.stdin is not None
        for index in range(frame_count):
            values = frames.frame(index, frame_count)
            valid = np.isfinite(values)
            if static_mask is None:
                static_mask = valid.copy()
                union_mask = valid.copy()
            else:
                static_mask &= valid
                assert union_mask is not None
                union_mask |= valid
            encoded = render_scalar_luma(values, config)
            expected_samples.append((
                encoded[::y_stride, ::x_stride, 0].copy(),
                valid[::y_stride, ::x_stride].copy(),
            ))
            process.stdin.write(encoded.tobytes())
            if index == 0 or (index + 1) % max(1, round(config["output"]["fps"])) == 0:
                print(f"Rendered {index + 1}/{frame_count} frames", file=sys.stderr)
        process.stdin.close()
        return_code = process.wait()
        if return_code:
            raise RuntimeError(f"ffmpeg exited with status {return_code}")
    except Exception:
        process.kill()
        raise

    assert static_mask is not None and union_mask is not None
    write_mask_png(mask_path, static_mask)
    sampled_static_mask = static_mask[::y_stride, ::x_stride]
    expected_samples = [(expected, sampled_static_mask) for expected, _valid in expected_samples]
    mask_report = {
        "strategy": "intersection",
        "validPixels": int(np.count_nonzero(static_mask)),
        "varyingPixelsExcluded": int(np.count_nonzero(union_mask != static_mask)),
        "totalPixels": int(static_mask.size),
    }
    probe = probe_media(video_path, config, frame_count / config["output"]["fps"])
    value_validation = validate_encoded_values(
        video_path, expected_samples, config["output"]["width"], config["output"]["height"],
    )
    manifest = create_manifest(config, layer, "video.mp4", "mask.png", frames.samples)
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    report = {
        **summary,
        "videoBytes": video_path.stat().st_size,
        "maskBytes": mask_path.stat().st_size,
        "maskValidation": mask_report,
        "valueValidation": value_validation,
        "probe": probe,
        "manifest": manifest,
    }
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"video": str(video_path), "manifest": str(directory / "manifest.json")}, indent=2))
    if args.upload:
        url = publish(directory, config, artifact_id)
        print(json.dumps({"manifestUrl": url}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
