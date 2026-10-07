#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "aiohttp>=3.9",
#   "fsspec>=2025.3",
#   "numpy>=2.0",
#   "pillow>=10",
#   "requests>=2.32",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""Vector GeoVideo lab: measure codec losses on u/v fields and export browser test assets.

u and v are quantized to 8-bit codes, stacked vertically (u over v) and written
straight into the luma (Y) plane, so the codec is the only source of loss. The
browser page in src/demo-geovideo-vector compares the decoded fields with the
float reference using the real particle renderer.

Usage:
  uv run scripts/geovideo/vector_lab.py measure swell
  uv run scripts/geovideo/vector_lab.py export swell
  uv run scripts/geovideo/vector_lab.py export current
  npm run dev:geovideo-vector
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts" / "geovideo-vector"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_vector import (  # noqa: E402  shared with the production renderer
    CODE_MAX,
    CODE_MIN,
    block_centers,
    block_mean,
    decode_values,
    decode_video,
    derive_uv,
    luma_frame,
    open_encoder,
    write_frame,
)

DATASETS = {
    "swell": {
        "label": "Primary swell (VHM0_SW1 / VMDR_SW1)",
        "url": "https://s3.waw3-1.cloudferro.com/mdl-arco-time-015/arco/GLOBAL_ANALYSISFORECAST_WAV_001_027/cmems_mod_glo_wav_anfc_0.083deg_PT3H-i_202411/timeChunked.zarr",
        "kind": "direction_magnitude",
        "direction": "VMDR_SW1",
        "magnitude": "VHM0_SW1",
        "unit": "m",
    },
    "current": {
        "label": "Surface current (uo / vo)",
        "url": "https://s3.waw3-1.cloudferro.com/mdl-arco-time-009/arco/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i_202406/timeChunked.zarr",
        "kind": "uv",
        "u": "uo",
        "v": "vo",
        "unit": "m/s",
    },
}
START = np.datetime64("2026-10-01T00:00")
FACTOR = 3  # 4320 x 2040 native -> 1440 x 680 (0.25 deg)
FPS = 4
SCHEMES = ("linear", "sqrt")

# id, extension, encoder arguments
CODECS = {
    "h264_crf08": ("mp4", ["-c:v", "libx264", "-preset", "slow", "-crf", "8", "-g", "12"]),
    "h264_crf14": ("mp4", ["-c:v", "libx264", "-preset", "slow", "-crf", "14", "-g", "12"]),
    "h264_crf20": ("mp4", ["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-g", "12"]),
    "h264_crf26": ("mp4", ["-c:v", "libx264", "-preset", "slow", "-crf", "26", "-g", "12"]),
    "h264_crf14_g1": ("mp4", ["-c:v", "libx264", "-preset", "slow", "-crf", "14", "-g", "1"]),
    "vp9_crf20": ("webm", ["-c:v", "libvpx-vp9", "-crf", "20", "-b:v", "0", "-g", "12",
                           "-deadline", "good", "-cpu-used", "2", "-row-mt", "1"]),
    "vp9_crf32": ("webm", ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-g", "12",
                           "-deadline", "good", "-cpu-used", "2", "-row-mt", "1"]),
    "av1_crf20": ("mp4", ["-c:v", "libsvtav1", "-crf", "20", "-preset", "6", "-g", "12"]),
    "av1_crf32": ("mp4", ["-c:v", "libsvtav1", "-crf", "32", "-preset", "6", "-g", "12"]),
}
# Browser variants exported next to the lossless PNG reference
EXPORT_VIDEOS = [
    ("sqrt", "h264_crf14"),
    ("sqrt", "h264_crf20"),
    ("sqrt", "h264_crf26"),
    ("linear", "h264_crf14"),
    ("sqrt", "av1_crf32"),
]
# ── data ────────────────────────────────────────────────────────────────

def load(name: str, frames: int) -> dict[str, np.ndarray]:
    """Frames on the 0.25 deg grid, north up. Cached under artifacts/."""
    cache = OUT / "cache" / f"{name}_{frames}.npz"
    if cache.exists():
        return dict(np.load(cache))
    cfg = DATASETS[name]
    ds = xr.open_zarr(cfg["url"], consolidated=True, chunks=None, zarr_format=2)
    if "elevation" in ds.dims:
        ds = ds.isel(elevation=int(np.argmin(np.abs(ds["elevation"].values))))
    t0 = int(np.searchsorted(ds["time"].values, START))
    lat = np.asarray(ds["latitude"].values, np.float64)
    lat_desc = lat[0] > lat[-1]
    us, vs, times = [], [], []
    for i in range(t0, t0 + frames):
        tic = time.time()
        sel = ds.isel(time=i)
        if cfg["kind"] == "uv":
            u = np.asarray(sel[cfg["u"]].values, np.float32)
            v = np.asarray(sel[cfg["v"]].values, np.float32)
        else:
            direction = np.asarray(sel[cfg["direction"]].values, np.float32)
            magnitude = np.asarray(sel[cfg["magnitude"]].values, np.float32)
            u, v = derive_uv(direction, magnitude, {"direction_convention": "from", "output_direction": "toward"})
        if not lat_desc:
            u, v = u[::-1], v[::-1]
        us.append(block_mean(u, FACTOR))
        vs.append(block_mean(v, FACTOR))
        times.append(ds["time"].values[i])
        print(f"  loaded {str(times[-1])[:16]} in {time.time() - tic:.1f}s", flush=True)
    data = {
        "u": np.stack(us),
        "v": np.stack(vs),
        "times": np.array(times, dtype="datetime64[ms]"),
        "latitude": block_centers(lat if lat_desc else lat[::-1], FACTOR).astype(np.float32),
        "longitude": block_centers(np.asarray(ds["longitude"].values, np.float64), FACTOR).astype(np.float32),
    }
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, **data)
    return data


def domain(u: np.ndarray, v: np.ndarray, valid: np.ndarray) -> float:
    return float(np.percentile(np.abs(np.concatenate([u[valid], v[valid]])), 99.9))


# ── quantization ────────────────────────────────────────────────────────

def luma_frames(u, v, valid, m, scheme) -> list[np.ndarray]:
    return [luma_frame(u[k], v[k], valid[k], m, scheme) for k in range(u.shape[0])]


def encode_video(frames: list[np.ndarray], codec: list[str], path: Path) -> int:
    h, w = frames[0].shape
    encoder = open_encoder(path, w, h, FPS, codec)
    for frame in frames:
        write_frame(encoder, frame)
    assert encoder.stdin is not None
    encoder.stdin.close()
    if encoder.wait() != 0:
        raise RuntimeError(f"encode failed: {codec}")
    return path.stat().st_size


# ── metrics ─────────────────────────────────────────────────────────────

def bilinear(f: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = f.shape
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    x0 %= w
    x1 = (x0 + 1) % w
    y0 = np.clip(y0, 0, h - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    return (f[y0, x0] * (1 - fx) * (1 - fy) + f[y0, x1] * fx * (1 - fy)
            + f[y1, x0] * (1 - fx) * fy + f[y1, x1] * fx * fy)


def advect(u, v, valid, seeds, px_per_unit, steps=200):
    """RK2 advection in grid pixels (north up: y grows with -v). Stops on land."""
    fu = np.where(valid, u, 0)
    fv = np.where(valid, v, 0)
    fm = valid.astype(np.float32)
    x, y = seeds[:, 0].copy(), seeds[:, 1].copy()
    alive = np.ones(len(x), bool)
    for _ in range(steps):
        du, dv = bilinear(fu, x, y), bilinear(fv, x, y)
        xm, ym = x + 0.5 * du * px_per_unit, y - 0.5 * dv * px_per_unit
        du, dv = bilinear(fu, xm, ym), bilinear(fv, xm, ym)
        nx, ny = x + du * px_per_unit, y - dv * px_per_unit
        alive &= bilinear(fm, nx, ny) > 0.5
        x, y = np.where(alive, nx, x), np.where(alive, ny, y)
    return np.stack([x, y], 1)


def wrapped(d: np.ndarray, width: int) -> np.ndarray:
    d = d.copy()
    d[:, 0] = (d[:, 0] + width / 2) % width - width / 2
    return np.hypot(d[:, 0], d[:, 1])


def metrics(ref_u, ref_v, dec_u, dec_v, valid, traj_frames, seeds_per_frame=4000) -> dict:
    ru, rv, du, dv = ref_u[valid], ref_v[valid], dec_u[valid], dec_v[valid]
    rs, ds = np.hypot(ru, rv), np.hypot(du, dv)
    ang = np.abs((np.degrees(np.arctan2(du, dv) - np.arctan2(ru, rv)) + 180) % 360 - 180)
    q = np.quantile(rs, [0.25, 0.5, 0.75])
    bins = np.digitize(rs, q)
    out = {
        "rmse_uv": float(np.sqrt(np.mean(np.concatenate([(du - ru) ** 2, (dv - rv) ** 2])))),
        "angle_med": float(np.median(ang)),
        "angle_p95": float(np.percentile(ang, 95)),
        "angle_wmean": float(np.sum(ang * rs) / np.sum(rs)),
        "angle_p95_by_quartile": [float(np.percentile(ang[bins == b], 95)) for b in range(4)],
        "speed_relerr_med": float(np.median(np.abs(ds - rs)[rs > q[0]] / rs[rs > q[0]])),
    }
    rng = np.random.default_rng(0)
    px_per_unit = 1.0 / float(np.percentile(rs, 99))
    width = valid.shape[2]
    dists, paths = [], []
    for k in traj_frames:
        ys, xs = np.nonzero(valid[k])
        pick = rng.choice(len(xs), seeds_per_frame, replace=False)
        seeds = np.stack([xs[pick] + 0.5, ys[pick] + 0.5], 1).astype(np.float64)
        a = advect(ref_u[k], ref_v[k], valid[k], seeds, px_per_unit)
        b = advect(dec_u[k], dec_v[k], valid[k], seeds, px_per_unit)
        dists.append(wrapped(a - b, width))
        paths.append(wrapped(a - seeds, width))
    dist, path = np.concatenate(dists), np.concatenate(paths)
    moving = path > 5
    out["traj_px_med"] = float(np.median(dist))
    out["traj_px_p95"] = float(np.percentile(dist, 95))
    out["traj_rel_med"] = float(np.median(dist[moving] / path[moving]))
    return out


# ── commands ────────────────────────────────────────────────────────────

def measure(name: str, frames: int, traj_frames: int) -> None:
    data = load(name, frames)
    u, v = data["u"], data["v"]
    valid = np.isfinite(u) & np.isfinite(v)
    m = domain(u, v, valid)
    n, h, w = u.shape
    traj = list(np.linspace(0, n - 1, traj_frames).round().astype(int))
    outdir = OUT / "measure" / name
    outdir.mkdir(parents=True, exist_ok=True)
    print(f"[{name}] grid {w}x{h}, {n} frames, domain ±{m:.3f} {DATASETS[name]['unit']}")
    rows = []
    for scheme in SCHEMES:
        frames_luma = luma_frames(u, v, valid, m, scheme)
        for codec_id in [None, *CODECS]:
            if codec_id is None:
                decoded, size = frames_luma, None
            else:
                ext, args = CODECS[codec_id]
                path = outdir / f"{scheme}_{codec_id}.{ext}"
                size = encode_video(frames_luma, args, path)
                decoded = list(decode_video(path, 2 * h, w))
            du = np.stack([decode_values(f[:h], m, scheme) for f in decoded])
            dv = np.stack([decode_values(f[h:], m, scheme) for f in decoded])
            r = metrics(u, v, du, dv, valid, traj)
            r.update(scheme=scheme, codec=codec_id or "quant-only",
                     kb_per_frame=None if size is None else size / n / 1e3)
            rows.append(r)
            kb = "      -" if size is None else f"{size / n / 1e3:7.1f}"
            print(f"  {scheme:6} {r['codec']:14} {kb} kB/fr  angle med {r['angle_med']:5.2f}° "
                  f"p95 {r['angle_p95']:6.2f}°  p95/quartile {[round(x, 1) for x in r['angle_p95_by_quartile']]}  "
                  f"traj med {r['traj_px_med']:5.2f}px p95 {r['traj_px_p95']:6.2f}px", flush=True)
    (outdir / "results.json").write_text(json.dumps({"dataset": name, "domain": m, "rows": rows}, indent=1))


def export(name: str, frames: int) -> None:
    """Assets for src/demo-geovideo-vector: float reference, lossless PNG codes, videos, meta.json."""
    data = load(name, frames)
    u, v = data["u"], data["v"]
    valid = np.isfinite(u) & np.isfinite(v)
    m = domain(u, v, valid)
    n, h, w = u.shape
    outdir = OUT / name
    (outdir / "ref").mkdir(parents=True, exist_ok=True)
    (outdir / "png").mkdir(exist_ok=True)
    for k in range(n):
        (outdir / "ref" / f"frame_{k:02d}.bin").write_bytes(
            np.concatenate([u[k].ravel(), v[k].ravel()]).astype("<f4").tobytes())
    variants = []
    luma = {scheme: luma_frames(u, v, valid, m, scheme) for scheme in SCHEMES}
    png_bytes = 0
    for k, f in enumerate(luma["sqrt"]):
        buffer = io.BytesIO()
        Image.fromarray(f, "L").save(buffer, "PNG", optimize=True)
        (outdir / "png" / f"sqrt_{k:02d}.png").write_bytes(buffer.getvalue())
        png_bytes += buffer.tell()
    variants.append({"id": "png_sqrt", "kind": "png", "scheme": "sqrt", "pattern": "png/sqrt_{k}.png",
                     "label": "PNG 8-bit lossless (sqrt)", "kbPerFrame": png_bytes / n / 1e3})
    for scheme, codec_id in EXPORT_VIDEOS:
        ext, args = CODECS[codec_id]
        file = f"{scheme}_{codec_id}.{ext}"
        size = encode_video(luma[scheme], args, outdir / file)
        variants.append({"id": f"{scheme}_{codec_id}", "kind": "video", "scheme": scheme, "file": file,
                         "label": f"{codec_id.replace('_', ' ').upper()} ({scheme})", "kbPerFrame": size / n / 1e3})
        print(f"  {file}: {size / n / 1e3:.0f} kB/frame", flush=True)
    meta = {
        "dataset": name,
        "label": DATASETS[name]["label"],
        "unit": DATASETS[name]["unit"],
        "width": w,
        "height": h,
        "frames": n,
        "fps": FPS,
        "timesMs": data["times"].astype("datetime64[ms]").astype(np.int64).tolist(),
        "latitude": [round(float(x), 5) for x in data["latitude"][:h]],
        "longitude": [round(float(x), 5) for x in data["longitude"][:w]],
        "domain": m,
        "codeMin": CODE_MIN,
        "codeMax": CODE_MAX,
        "variants": variants,
    }
    (outdir / "meta.json").write_text(json.dumps(meta))
    index = OUT / "index.json"
    names = sorted({*json.loads(index.read_text()).get("datasets", []), name}) if index.exists() else [name]
    index.write_text(json.dumps({"datasets": names}))
    print(f"[{name}] exported {n} frames to {outdir.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["measure", "export"])
    parser.add_argument("dataset", choices=DATASETS)
    parser.add_argument("--frames", type=int, default=12)
    parser.add_argument("--traj-frames", type=int, default=3)
    args = parser.parse_args()
    if args.command == "measure":
        measure(args.dataset, args.frames, args.traj_frames)
    else:
        export(args.dataset, args.frames)
    return 0


if __name__ == "__main__":
    sys.exit(main())
