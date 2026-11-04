#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.35",
#   "dask[array]>=2025.1",
#   "fsspec>=2025.3",
#   "numcodecs>=0.15",
#   "numpy>=2.0",
#   "planetary-computer>=1.0",
#   "pystac-client>=0.8",
#   "rasterio>=1.4",
#   "s3fs>=2025.3",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""Landsat yearly land and water, Malé atoll (Maldives) → Zarr on the zartigl bucket.

For each year, every Landsat 5, 7, 8 and 9 Collection 2 Level-2 scene of the
area (Microsoft Planetary Computer STAC) is warped onto the store grid. The
pipeline keeps the clear pixels (QA_PIXEL: no fill, dilated cloud, cloud or
cloud shadow; no surface reflectance below zero, which over-corrected haze
gives over deep water) and stores per-pixel medians of the SWIR1 surface
reflectance (`swir1`: land, sand and buildings are bright, water is dark) and
of the modified normalized difference water index (`mndwi`). New land
reclaimed from the lagoon shows as a pixel that turns bright.

Until `pool.until`, when few scenes reach the Maldives (Landsat 5 and 7), each
frame pools the scenes of its year and of the `pool.years` - 1 years before.
GeoVideo hides for the whole animation any pixel that is missing in one frame,
so a pixel without a clear observation in a year keeps its value of the
previous year; the store attribute `history` says so, and the variable
`observed` gives the number of clear observations behind each value (0 for a
carried value).

`run` builds both stores, then, in later runs, appends each new complete year
(a year is complete on 1 January of the next): the nightly workflow
(.github/workflows/to-zarr.yml) calls the same commands as for the daily
products, and does nothing on the other days.

Usage:
  uv run scripts/to_zarr/usgs/landsat_mndwi/convert.py plan [--local DIR]
  uv run scripts/to_zarr/usgs/landsat_mndwi/convert.py run [--rebuild] [--local DIR]
  uv run scripts/to_zarr/usgs/landsat_mndwi/convert.py sync-geo   # no-op: run writes geoChunked too

Landsat data are in the public domain; credit "Landsat imagery courtesy of
the U.S. Geological Survey".
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any, Callable, Iterator

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import common  # noqa: E402
import contract  # noqa: E402

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
FILL = -32768
SCALE = 1e-4
# QA_PIXEL bits that make a pixel unusable: fill, dilated cloud, cloud, cloud shadow.
QA_REJECT = (1 << 0) | (1 << 1) | (1 << 3) | (1 << 4)
# Collection 2 Level-2 surface reflectance: DN * 0.0000275 - 0.2.
REFLECTANCE = (2.75e-5, -0.2)
MIN_REFLECTANCE = 0.001
LICENSE = (
    "Landsat data are in the public domain. Landsat imagery courtesy of the U.S. Geological Survey. "
    "Composited by UNEP/GRID-Geneva."
)

# A scene reader returns green, SWIR1 and QA_PIXEL warped onto the store grid.
Scene = tuple[np.ndarray, np.ndarray, np.ndarray]
SceneReader = Callable[[Any, dict[str, Any]], Scene]


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


def grid(config: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Cell centres, both ascending."""
    box, cell = config["bbox"], config["cell"]
    nx = round((box["east"] - box["west"]) / cell)
    ny = round((box["north"] - box["south"]) / cell)
    return box["south"] + cell * (np.arange(ny) + 0.5), box["west"] + cell * (np.arange(nx) + 0.5)


def last_year(config: dict[str, Any], today: date | None = None) -> int:
    """The last complete year, unless config.json pins `lastYear`."""
    return config.get("lastYear") or (today or date.today()).year - 1


def years(config: dict[str, Any], today: date | None = None) -> list[int]:
    return list(range(config["firstYear"], last_year(config, today) + 1))


def mndwi(green: np.ndarray, swir: np.ndarray, qa: np.ndarray) -> np.ndarray:
    """MNDWI of the clear pixels of one scene, NaN elsewhere."""
    return observe(green, swir, qa)[0]


def observe(green: np.ndarray, swir: np.ndarray, qa: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """MNDWI and SWIR1 surface reflectance of the clear pixels of one scene, NaN elsewhere."""
    scale, offset = REFLECTANCE
    g = green.astype(np.float32) * scale + offset
    s = swir.astype(np.float32) * scale + offset
    with np.errstate(invalid="ignore", divide="ignore"):
        index = (g - s) / (g + s)
    # Over-corrected haze and sun glint give negative green reflectance over deep water, which
    # flips the index to land: a surface reflectance below MIN_REFLECTANCE is not an observation.
    clear = (((qa.astype(np.int64) & QA_REJECT) == 0) & (green > 0) & (swir > 0)
             & (g > MIN_REFLECTANCE) & (s > -MIN_REFLECTANCE) & np.isfinite(index))
    return (np.where(clear, np.clip(index, -1, 1), np.nan).astype(np.float32),
            np.where(clear, np.clip(s, 0, 1), np.nan).astype(np.float32))


def yearly(stack: list[np.ndarray], shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Median and number of clear observations of one year's scenes."""
    if not stack:
        return np.full(shape, np.nan, np.float32), np.zeros(shape, np.int16)
    cube = np.stack(stack)
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            median = np.nanmedian(cube, axis=0)
    return median.astype(np.float32), np.isfinite(cube).sum(axis=0).astype(np.int16)


def carry_forward(values: np.ndarray) -> np.ndarray:
    """Each missing pixel takes its last observed value; pixels never observed stay NaN until they are."""
    out = values.copy()
    for index in range(1, out.shape[0]):
        missing = np.isnan(out[index])
        out[index][missing] = out[index - 1][missing]
    # Pixels missing in the first years take their first observed value, so the mask stays full.
    for index in range(out.shape[0] - 2, -1, -1):
        missing = np.isnan(out[index])
        out[index][missing] = out[index + 1][missing]
    return out


def stac_items(config: dict[str, Any], frames: list[int]) -> Iterator[Any]:
    """The scenes behind the frames, including the earlier years pooled into them."""
    import planetary_computer
    import pystac_client

    catalog = pystac_client.Client.open(config["stac"], modifier=planetary_computer.sign_inplace)
    box = config["bbox"]
    start = min(year - pool_years(config, year) + 1 for year in frames)
    search = catalog.search(
        collections=[config["collection"]],
        bbox=[box["west"], box["south"], box["east"], box["north"]],
        datetime=f"{start}-01-01/{max(frames)}-12-31",
        query={"eo:cloud_cover": {"lt": config["maxCloudCover"]}},
    )
    yield from search.items()


def warp_scene(item: Any, config: dict[str, Any]) -> Scene:
    """Green, SWIR1 and QA_PIXEL of a scene, nearest-warped onto the store grid."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.vrt import WarpedVRT

    lat, lon = grid(config)
    box, cell = config["bbox"], config["cell"]
    transform = from_origin(box["west"], box["south"] + cell * len(lat), cell, cell)
    bands = []
    for asset in ("green", "swir16", "qa_pixel"):
        with rasterio.open(item.assets[asset].href) as source, WarpedVRT(
            source, crs="EPSG:4326", transform=transform, width=len(lon), height=len(lat),
            resampling=Resampling.nearest, nodata=0,
        ) as vrt:
            bands.append(vrt.read(1)[::-1])  # north-up rows → ascending latitude
    return bands[0], bands[1], bands[2]


def pool_years(config: dict[str, Any], year: int) -> int:
    """Years of scenes behind the frame of `year`: the year itself and the ones before it up to `pool.years`,
    for the years until `pool.until`, when few Landsat scenes reach the area."""
    pool = config.get("pool")
    return pool["years"] if pool and year <= pool["until"] else 1


def pool_note(config: dict[str, Any]) -> str:
    pool = config.get("pool")
    if not pool:
        return ""
    return (f"until {pool['until']}, each frame pools the scenes of its year and the "
            f"{pool['years'] - 1} years before it; ")


def composite(config: dict[str, Any], items: list[Any], reader: SceneReader,
              frames: list[int] | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Medians of MNDWI and of SWIR1 reflectance for each frame year, and the clear observation counts."""
    lat, lon = grid(config)
    shape = (len(lat), len(lon))
    cache: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    indices, swirs, counts = [], [], []
    for year in frames if frames is not None else years(config):
        span = pool_years(config, year)
        scenes = [item for item in items if year - span < item.datetime.year <= year]
        observed = []
        for item in scenes:
            if id(item) not in cache:
                cache[id(item)] = observe(*reader(item, config))
            observed.append(cache[id(item)])
        index, count = yearly([pair[0] for pair in observed], shape)
        swir, _ = yearly([pair[1] for pair in observed], shape)
        indices.append(index)
        swirs.append(swir)
        counts.append(count)
        print(f"{year}: {len(scenes)} scenes, {int((count > 0).sum())} of {count.size} pixels observed",
              flush=True)
    return np.stack(indices), np.stack(swirs), np.stack(counts)


def carried(values: np.ndarray, previous: np.ndarray | None) -> np.ndarray:
    """`carry_forward` from the last stored frame when appending, so new frames start from it."""
    if previous is None:
        return carry_forward(values)
    return carry_forward(np.concatenate([previous[None], values]))[1:]


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def store_attrs(config: dict[str, Any], frames: list[int], counts: np.ndarray) -> dict[str, str]:
    return {
        "title": "Land and water from Landsat, yearly, Malé atoll, Maldives",
        "source": "USGS Landsat Collection 2 Level-2 (Landsat 5, 7, 8, 9) via the Microsoft "
                  "Planetary Computer STAC (collection landsat-c2-l2)",
        "license": LICENSE,
        "history": history_line(config, frames, counts),
    }


def history_line(config: dict[str, Any], frames: list[int], counts: np.ndarray) -> str:
    return (f"{stamp()}: {frames[0]}–{frames[-1]}, per-year medians of SWIR1 reflectance and MNDWI over "
            f"clear pixels (QA_PIXEL), nearest-warped onto a {config['cell']} degree grid; "
            f"{int((counts == 0).sum())} pixel-years without a clear observation carry the value of the "
            "nearest earlier year (or later, before the first observation); "
            f"{pool_note(config)}by zartigl scripts/to_zarr/usgs/landsat_mndwi")


def dataset(config: dict[str, Any], frames: list[int], medians: np.ndarray, swirs: np.ndarray,
            counts: np.ndarray, previous: dict[str, np.ndarray] | None = None) -> xr.Dataset:
    lat, lon = grid(config)
    time = np.array([np.datetime64(f"{year}-12-31T00:00", "ns") for year in frames])
    before = previous or {}
    result = xr.Dataset(
        {
            "swir1": (("time", "latitude", "longitude"), carried(swirs, before.get("swir1")), {
                "long_name": "Yearly median of the SWIR1 surface reflectance (1.6 um): "
                             "land, sand and buildings are bright, water is dark",
                "units": "1", "valid_min": 0.0, "valid_max": 1.0,
            }),
            "mndwi": (("time", "latitude", "longitude"), carried(medians, before.get("mndwi")), {
                "long_name": "Yearly median of the modified normalized difference water index "
                             "(green - SWIR1) / (green + SWIR1); land below 0, water above",
                "units": "1", "valid_min": -1.0, "valid_max": 1.0,
                "comment": "Biased towards land over deep water in hazy or glint-affected Landsat 8 and 9 "
                           "scenes; swir1 separates land from water more reliably here",
            }),
            "observed": (("time", "latitude", "longitude"), counts.astype(np.float32), {
                "long_name": "Clear Landsat observations behind the yearly value (0: value of another year)",
                "units": "1", "valid_min": 0.0,
            }),
        },
        coords={"time": time, "latitude": lat, "longitude": lon},
    )
    result["latitude"].attrs = {"standard_name": "latitude", "units": "degrees_north"}
    result["longitude"].attrs = {"standard_name": "longitude", "units": "degrees_east"}
    result.attrs = store_attrs(config, frames, counts)
    return result


def encodings(names: list[str]) -> dict[str, dict[str, Any]]:
    from numcodecs import Blosc

    compressor = Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE)
    result: dict[str, dict[str, Any]] = {
        "time": {"units": "hours since 1981-01-01 00:00:00", "calendar": "standard", "dtype": "int32"},
    }
    for name in names:
        result[name] = {"dtype": "int16", "_FillValue": FILL, "compressors": (compressor,),
                        **({"scale_factor": SCALE} if name in ("mndwi", "swir1") else {})}
    return result


def stored_years(target: common.Target) -> list[int]:
    return [int(str(value)[:4]) for value in common.stored_times(target, "timeChunked")]


def pending(config: dict[str, Any], target: common.Target, today: date | None = None) -> list[int]:
    """Frame years to write: all of them for a new store, else the complete years after the last stored."""
    stored = stored_years(target)
    if not stored:
        return years(config, today)
    return [year for year in years(config, today) if year > stored[-1]]


def remove(target: common.Target, name: str) -> None:
    store = target.store(name)
    if isinstance(store, str):
        import shutil

        shutil.rmtree(store, ignore_errors=True)
    else:
        store.clear()


def plan(config: dict[str, Any], target: common.Target, today: date | None = None) -> str:
    stored, todo = stored_years(target), pending(config, target, today)
    have = f"{stored[0]}–{stored[-1]} stored" if stored else "missing"
    return f"{config['prefix']}: {have}; " + (f"run writes {todo[0]}–{todo[-1]}" if todo else "nothing to do")


def run(config: dict[str, Any], target: common.Target, *, today: date | None = None, rebuild: bool = False,
        items: list[Any] | None = None, reader: SceneReader | None = None) -> None:
    """Builds the stores, or appends the complete years after the last stored one to both of them."""
    if rebuild:
        for name in config["stores"]:
            remove(target, name)
    frames = pending(config, target, today)
    if not frames:
        print(plan(config, target, today), flush=True)
        return
    appending = bool(stored_years(target))
    found = list(stac_items(config, frames)) if items is None else items
    medians, swirs, counts = composite(config, found, reader or warp_scene, frames)
    previous = None
    if appending:
        last = common.open_store(target, "timeChunked").isel(time=-1)
        previous = {name: last[name].values for name in ("swir1", "mndwi")}
    data = dataset(config, frames, medians, swirs, counts, previous)
    specs = encodings(list(data.data_vars))
    for store, chunks in config["stores"].items():
        sizes = {dim: min(chunks[dim], data.sizes[dim]) for dim in ("latitude", "longitude")}
        if appending:
            existing = common.open_store(target, store, decode=False)
            data.attrs = {**existing.attrs,
                          "history": f"{existing.attrs.get('history', '')}\n{history_line(config, frames, counts)}"}
            times = common.append_chunks(existing.sizes["time"], len(frames), chunks["time"])
            common.write(data.chunk({"time": times, **sizes}), target, store, {**sizes, "time": chunks["time"]},
                         specs, append=True)
        else:
            store_chunks = {**sizes, "time": min(chunks["time"], len(frames))}
            common.write(data.chunk(store_chunks), target, store, store_chunks, specs, append=False)
        print(f"{store}: {frames[0]}–{frames[-1]} written", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (("plan", "list the complete years to write"),
                       ("run", "build the stores, or append the new complete years"),
                       ("sync-geo", "nothing to do: run writes both stores")):
        command = commands.add_parser(name, help=text)
        command.add_argument("--local", help="use this directory instead of the bucket")
        command.add_argument("--budget", type=common.parse_budget, default="24h",
                             help="accepted for the shared workflow; a run is a few minutes")
        command.add_argument("--force", action="store_true", help="accepted for the shared workflow")
        if name == "run":
            command.add_argument("--rebuild", action="store_true", help="delete both stores and build again")
    args = parser.parse_args()
    config = load_config()
    if args.command == "sync-geo":
        print("geoChunked.zarr is written by run", flush=True)
        return
    target = common.target_from_args(args, config["prefix"])
    if args.command == "plan":
        print(plan(config, target), flush=True)
    else:
        run(config, target, rebuild=args.rebuild)


if __name__ == "__main__":
    main()
