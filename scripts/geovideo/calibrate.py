#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "numpy>=2.0",
# ]
# ///
"""Measure scalar and vector values after an H.264/yuv420p round trip."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import shutil
import subprocess
from typing import Any, Iterator

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
VALID_MIN = 8
VALID_MAX = 247
NODATA_MAX = 7


def component_codes(width: int, height: int, frame: int, variant: int) -> np.ndarray:
    """Build stable ramps plus moving edges and deterministic texture."""
    y, x = np.indices((height, width), dtype=np.uint32)
    stripe = np.minimum(255, x * 256 // width).astype(np.uint8)
    diagonal = ((x * 251 // width + y * 239 // height + frame * (3 + variant)) % 256).astype(np.uint8)
    blocks = np.choose(
        ((x // 32 + y // 32 + frame // 4 + variant) % 6).astype(np.uint8),
        [0, 7, 8, 64, 192, 247],
    ).astype(np.uint8)
    hashed = ((x * 73 + y * 151 + frame * 29 + variant * 97) & 255).astype(np.uint8)
    result = np.empty((height, width), dtype=np.uint8)
    quarter = height // 4
    result[:quarter] = stripe[:quarter]
    result[quarter:2 * quarter] = diagonal[quarter:2 * quarter]
    result[2 * quarter:3 * quarter] = blocks[2 * quarter:3 * quarter]
    result[3 * quarter:] = hashed[3 * quarter:]
    return result


def rgb_frame(kind: str, width: int, height: int, frame: int) -> tuple[np.ndarray, tuple[np.ndarray, ...]]:
    first = component_codes(width, height, frame, 0)
    first_rgb = np.repeat(first[:, :, None], 3, axis=2)
    if kind == "scalar":
        return first_rgb, (first,)
    second = component_codes(width, height, frame, 1)
    second_rgb = np.repeat(second[:, :, None], 3, axis=2)
    return np.concatenate([first_rgb, second_rgb], axis=1), (first, second)


def encode(
    kind: str,
    path: Path,
    width: int,
    height: int,
    frames: int,
    fps: int,
    crf: int,
    max_bitrate: str,
) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required")
    packed_width = width if kind == "scalar" else width * 2
    command = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{packed_width}x{height}",
        "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", "fast",
        "-crf", str(crf), "-maxrate", max_bitrate, "-bufsize", "16M",
        "-g", str(fps * 2), "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame in range(frames):
            rgb, _ = rgb_frame(kind, width, height, frame)
            process.stdin.write(rgb.tobytes())
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError(f"ffmpeg failed while encoding {kind}")
    except Exception:
        process.kill()
        raise


def decoded_frames(path: Path, packed_width: int, height: int) -> Iterator[np.ndarray]:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    process = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    assert process.stdout is not None
    frame_bytes = packed_width * height * 3
    while True:
        data = process.stdout.read(frame_bytes)
        if not data:
            break
        if len(data) != frame_bytes:
            process.kill()
            raise RuntimeError(f"Truncated decoded frame: {len(data)} of {frame_bytes} bytes")
        yield np.frombuffer(data, dtype=np.uint8).reshape(height, packed_width, 3)
    if process.wait() != 0:
        raise RuntimeError("ffmpeg failed while decoding")


def percentile_from_histogram(histogram: np.ndarray, percentile: float) -> int:
    target = math.ceil(int(histogram.sum()) * percentile)
    return int(np.searchsorted(np.cumsum(histogram), target, side="left"))


class CodeStats:
    def __init__(self) -> None:
        self.confusion = np.zeros((256, 256), dtype=np.int64)
        self.channel_spread_max = 0
        self.temporal_min = np.full(256, 255, dtype=np.uint8)
        self.temporal_max = np.zeros(256, dtype=np.uint8)
        self.temporal_seen = False

    def add(
        self,
        expected: np.ndarray,
        decoded_rgb: np.ndarray,
        sample_y: int | None = None,
    ) -> np.ndarray:
        decoded_float = (
            decoded_rgb[:, :, 0].astype(np.float32) * 0.2126
            + decoded_rgb[:, :, 1].astype(np.float32) * 0.7152
            + decoded_rgb[:, :, 2].astype(np.float32) * 0.0722
        )
        decoded = np.clip(np.rint(decoded_float), 0, 255).astype(np.uint8)
        spread = decoded_rgb.max(axis=2).astype(np.int16) - decoded_rgb.min(axis=2).astype(np.int16)
        self.channel_spread_max = max(self.channel_spread_max, int(spread.max()))
        bins = expected.astype(np.int32).ravel() * 256 + decoded.astype(np.int32).ravel()
        self.confusion += np.bincount(bins, minlength=256 * 256).reshape(256, 256)
        if sample_y is not None:
            sample_x = ((np.arange(256) * 2 + 1) * expected.shape[1]) // 512
            sample_x = np.minimum(expected.shape[1] - 1, sample_x)
            samples = decoded[sample_y, sample_x]
            self.temporal_min = np.minimum(self.temporal_min, samples)
            self.temporal_max = np.maximum(self.temporal_max, samples)
            self.temporal_seen = True
        return decoded

    def report(self) -> dict[str, Any]:
        expected_codes = np.arange(256)[:, None]
        decoded_codes = np.arange(256)[None, :]
        error = np.abs(expected_codes - decoded_codes)
        error_histogram = np.bincount(error.ravel(), weights=self.confusion.ravel(), minlength=256)
        total = int(self.confusion.sum())
        valid = self.confusion[VALID_MIN:VALID_MAX + 1]
        valid_total = int(valid.sum())
        modal = np.argmax(valid, axis=1)
        nodata_false_valid = int(self.confusion[:NODATA_MAX + 1, NODATA_MAX + 1:].sum())
        valid_false_nodata = int(valid[:, :NODATA_MAX + 1].sum())
        return {
            "samples": total,
            "exactPercent": float(self.confusion.trace() * 100 / total),
            "meanAbsoluteCodeError": float((error * self.confusion).sum() / total),
            "p99AbsoluteCodeError": percentile_from_histogram(error_histogram, 0.99),
            "maxAbsoluteCodeError": int(np.max(np.where(self.confusion > 0, error, 0))),
            "withinOneCodePercent": float(error_histogram[:2].sum() * 100 / total),
            "distinctValidModalCodes": int(np.unique(modal).size),
            "validSamples": valid_total,
            "nodataFalseValid": nodata_false_valid,
            "validFalseNodata": valid_false_nodata,
            "maxTemporalCodeSpan": (
                int((self.temporal_max.astype(np.int16) - self.temporal_min).max())
                if self.temporal_seen else None
            ),
            "maxRgbChannelSpread": self.channel_spread_max,
        }


class VectorStats:
    def __init__(self) -> None:
        self.samples = 0
        self.squared_error = 0.0
        self.speed_absolute_error = 0.0
        self.direction_absolute_error = 0.0
        self.direction_samples = 0
        self.max_vector_error = 0.0
        self.max_direction_error = 0.0

    def add(self, expected: tuple[np.ndarray, np.ndarray], decoded: tuple[np.ndarray, np.ndarray]) -> None:
        eu, ev = expected
        du, dv = decoded
        valid = (
            (eu >= VALID_MIN) & (eu <= VALID_MAX)
            & (ev >= VALID_MIN) & (ev <= VALID_MAX)
        )
        scale = 4.0 / (VALID_MAX - VALID_MIN)
        expected_u = (eu.astype(np.float32) - VALID_MIN) * scale - 2.0
        expected_v = (ev.astype(np.float32) - VALID_MIN) * scale - 2.0
        decoded_u = (du.astype(np.float32) - VALID_MIN) * scale - 2.0
        decoded_v = (dv.astype(np.float32) - VALID_MIN) * scale - 2.0
        delta = np.hypot(decoded_u - expected_u, decoded_v - expected_v)[valid]
        expected_speed = np.hypot(expected_u, expected_v)[valid]
        decoded_speed = np.hypot(decoded_u, decoded_v)[valid]
        self.samples += int(delta.size)
        self.squared_error += float(np.square(delta).sum())
        self.speed_absolute_error += float(np.abs(decoded_speed - expected_speed).sum())
        self.max_vector_error = max(self.max_vector_error, float(delta.max(initial=0)))
        # Direction is unstable and physically unimportant close to zero speed.
        direction_mask = expected_speed > 0.2
        expected_angle = np.arctan2(expected_v[valid][direction_mask], expected_u[valid][direction_mask])
        decoded_angle = np.arctan2(decoded_v[valid][direction_mask], decoded_u[valid][direction_mask])
        angle = np.abs(np.arctan2(np.sin(decoded_angle - expected_angle), np.cos(decoded_angle - expected_angle)))
        angle_degrees = np.degrees(angle)
        self.direction_samples += int(angle_degrees.size)
        self.direction_absolute_error += float(angle_degrees.sum())
        self.max_direction_error = max(self.max_direction_error, float(angle_degrees.max(initial=0)))

    def report(self) -> dict[str, Any]:
        return {
            "validVectorSamples": self.samples,
            "vectorRmse": math.sqrt(self.squared_error / self.samples),
            "speedMeanAbsoluteError": self.speed_absolute_error / self.samples,
            "directionMeanAbsoluteErrorDegrees": self.direction_absolute_error / self.direction_samples,
            "maxVectorError": self.max_vector_error,
            "maxDirectionErrorDegrees": self.max_direction_error,
            "componentRange": [-2.0, 2.0],
        }


def calibrate(
    kind: str,
    output: Path,
    width: int,
    height: int,
    frames: int,
    fps: int,
    crf: int,
    max_bitrate: str,
) -> dict[str, Any]:
    path = output / f"{kind}.mp4"
    encode(kind, path, width, height, frames, fps, crf, max_bitrate)
    component_count = 1 if kind == "scalar" else 2
    stats = [CodeStats() for _ in range(component_count)]
    region_names = ["stableRamp", "movingGradientWithWrap", "sharpNodataEdges", "noiseStress"]
    region_stats = [[CodeStats() for _ in region_names] for _ in range(component_count)]
    vector_stats = VectorStats() if kind == "vector" else None
    vector_region_stats = [VectorStats() for _ in region_names] if kind == "vector" else []
    decoded_count = 0
    packed_width = width * component_count
    for frame_index, decoded_rgb in enumerate(decoded_frames(path, packed_width, height)):
        _, expected = rgb_frame(kind, width, height, frame_index)
        decoded_components = []
        for component in range(component_count):
            start = component * width
            decoded_component_rgb = decoded_rgb[:, start:start + width]
            decoded_components.append(stats[component].add(
                expected[component], decoded_component_rgb, height // 8,
            ))
            boundaries = [0, height // 4, height // 2, 3 * height // 4, height]
            for region in range(len(region_names)):
                y0, y1 = boundaries[region], boundaries[region + 1]
                region_stats[component][region].add(
                    expected[component][y0:y1], decoded_component_rgb[y0:y1],
                )
        if vector_stats:
            vector_stats.add((expected[0], expected[1]), (decoded_components[0], decoded_components[1]))
            boundaries = [0, height // 4, height // 2, 3 * height // 4, height]
            for region in range(len(region_names)):
                y0, y1 = boundaries[region], boundaries[region + 1]
                vector_region_stats[region].add(
                    (expected[0][y0:y1], expected[1][y0:y1]),
                    (decoded_components[0][y0:y1], decoded_components[1][y0:y1]),
                )
        decoded_count += 1
    if decoded_count != frames:
        raise RuntimeError(f"Expected {frames} decoded {kind} frames, received {decoded_count}")
    raw_bytes = packed_width * height * 3 * frames
    result: dict[str, Any] = {
        "kind": kind,
        "dimensions": [packed_width, height],
        "frames": frames,
        "fps": fps,
        "videoBytes": path.stat().st_size,
        "rawBytes": raw_bytes,
        "compressionRatio": raw_bytes / path.stat().st_size,
        "components": [item.report() for item in stats],
        "regions": {
            name: [region_stats[component][region].report() for component in range(component_count)]
            for region, name in enumerate(region_names)
        },
    }
    if vector_stats:
        result["vector"] = vector_stats.report()
        result["vectorRegions"] = {
            name: vector_region_stats[region].report()
            for region, name in enumerate(region_names)
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, default=2048, help="Width of each scalar component")
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--frames", type=int, default=48)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--crf", type=int, default=20)
    parser.add_argument("--max-bitrate", default="8M")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "geovideo-calibration")
    args = parser.parse_args()
    if min(args.width, args.height, args.frames, args.fps) <= 0:
        parser.error("dimensions, frames, and fps must be positive")
    args.output.mkdir(parents=True, exist_ok=True)
    report = {
        "encoder": (
            f"libx264 crf={args.crf} maxrate={args.max_bitrate} "
            "bufsize=16M preset=fast yuv420p"
        ),
        "validCodes": [VALID_MIN, VALID_MAX],
        "nodataCodes": [0, NODATA_MAX],
        "scalar": calibrate(
            "scalar", args.output, args.width, args.height, args.frames, args.fps,
            args.crf, args.max_bitrate,
        ),
        "vector": calibrate(
            "vector", args.output, args.width, args.height, args.frames, args.fps,
            args.crf, args.max_bitrate,
        ),
        "scope": "FFmpeg round trip only; browser canvas/WebGL calibration remains required",
    }
    report_path = args.output / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"Report: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
