#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "numpy>=2.0",
# ]
# ///
"""Measure scalar-luma values after an H.264/yuv420p round trip."""

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


def component_codes(width: int, height: int, frame: int) -> np.ndarray:
    """Build stable ramps plus moving edges and deterministic texture."""
    y, x = np.indices((height, width), dtype=np.uint32)
    stripe = np.minimum(255, x * 256 // width).astype(np.uint8)
    diagonal = ((x * 251 // width + y * 239 // height + frame * 3) % 256).astype(np.uint8)
    blocks = np.choose(
        ((x // 32 + y // 32 + frame // 4) % 6).astype(np.uint8),
        [0, 7, 8, 64, 192, 247],
    ).astype(np.uint8)
    hashed = ((x * 73 + y * 151 + frame * 29) & 255).astype(np.uint8)
    result = np.empty((height, width), dtype=np.uint8)
    quarter = height // 4
    result[:quarter] = stripe[:quarter]
    result[quarter:2 * quarter] = diagonal[quarter:2 * quarter]
    result[2 * quarter:3 * quarter] = blocks[2 * quarter:3 * quarter]
    result[3 * quarter:] = hashed[3 * quarter:]
    return result


def rgb_frame(width: int, height: int, frame: int) -> tuple[np.ndarray, np.ndarray]:
    codes = component_codes(width, height, frame)
    return np.repeat(codes[:, :, None], 3, axis=2), codes


def encode(
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
    command = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
        "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", "fast",
        "-crf", str(crf), "-maxrate", max_bitrate, "-bufsize", "16M",
        "-g", str(fps * 2), "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame in range(frames):
            rgb, _ = rgb_frame(width, height, frame)
            process.stdin.write(rgb.tobytes())
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError("ffmpeg failed while encoding scalar-luma")
    except Exception:
        process.kill()
        raise


def decoded_frames(path: Path, width: int, height: int) -> Iterator[np.ndarray]:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    process = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    assert process.stdout is not None
    frame_bytes = width * height * 3
    while True:
        data = process.stdout.read(frame_bytes)
        if not data:
            break
        if len(data) != frame_bytes:
            process.kill()
            raise RuntimeError(f"Truncated decoded frame: {len(data)} of {frame_bytes} bytes")
        yield np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
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


def calibrate(
    output: Path,
    width: int,
    height: int,
    frames: int,
    fps: int,
    crf: int,
    max_bitrate: str,
) -> dict[str, Any]:
    path = output / "scalar.mp4"
    encode(path, width, height, frames, fps, crf, max_bitrate)
    stats = CodeStats()
    region_names = ["stableRamp", "movingGradientWithWrap", "sharpNodataEdges", "noiseStress"]
    region_stats = [CodeStats() for _ in region_names]
    decoded_count = 0
    for frame_index, decoded_rgb in enumerate(decoded_frames(path, width, height)):
        _, expected = rgb_frame(width, height, frame_index)
        stats.add(expected, decoded_rgb, height // 8)
        boundaries = [0, height // 4, height // 2, 3 * height // 4, height]
        for region in range(len(region_names)):
            y0, y1 = boundaries[region], boundaries[region + 1]
            region_stats[region].add(expected[y0:y1], decoded_rgb[y0:y1])
        decoded_count += 1
    if decoded_count != frames:
        raise RuntimeError(f"Expected {frames} decoded scalar frames, received {decoded_count}")
    raw_bytes = width * height * 3 * frames
    result: dict[str, Any] = {
        "kind": "scalar",
        "dimensions": [width, height],
        "frames": frames,
        "fps": fps,
        "videoBytes": path.stat().st_size,
        "rawBytes": raw_bytes,
        "compressionRatio": raw_bytes / path.stat().st_size,
        "components": [stats.report()],
        "regions": {
            name: [region_stats[region].report()]
            for region, name in enumerate(region_names)
        },
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, default=2048, help="Width of each scalar component")
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--frames", type=int, default=48)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--crf", type=int, default=12)
    parser.add_argument("--max-bitrate", default="16M")
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
            args.output, args.width, args.height, args.frames, args.fps,
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
