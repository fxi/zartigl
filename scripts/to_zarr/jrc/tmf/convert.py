#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.35",
#   "dask[array]>=2025.1",
#   "fsspec>=2025.3",
#   "numcodecs>=0.15",
#   "numpy>=2.0",
#   "rasterio>=1.4",
#   "requests>=2.32",
#   "s3fs>=2025.3",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""JRC Tropical Moist Forests (v1.2025), Congo Basin → yearly Zarr on the zartigl bucket.

The JRC maps the year in which each 30 m pixel of tropical moist forest was
first degraded and first deforested (`DegradationYear`, `DeforestationYear`).
For each year from `firstYear` to `lastYear`, this pipeline stores the share of
each cell of the `cell` grid whose first degradation (or deforestation) falls
between `firstYear` and that year: cumulative shares, 0 to 1.

The source is the COG mirror on source.coop, read at a COG overview
(`overviewLevel` 0 = every second pixel). The overviews are resampled with
`nearest`, so counting their pixels is an unbiased sample of the full
resolution. Cells outside the tiles are fill.

The product is static: `run` writes both stores once, in latitude bands that
match the store chunks, and does nothing afterwards. A new JRC release is a new
store version: change `prefix` (and `lastYear`) in config.json. The nightly
workflow (.github/workflows/to-zarr.yml) calls the same commands as for the
daily products.

Usage:
  uv run scripts/to_zarr/jrc/tmf/convert.py plan [--local DIR]
  uv run scripts/to_zarr/jrc/tmf/convert.py run [--rebuild] [--rows 600] [--local DIR]
  uv run scripts/to_zarr/jrc/tmf/convert.py sync-geo   # no-op: run writes geoChunked too

Without --local, stores are written to `prefix` of the bucket configured in
.env.demo / .env / the environment (S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET).

Licence: Copernicus / JRC open data, free of charge without restriction of
use; name the JRC as the source and cite Vancutsem et al. (2021).
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
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
LONG_NAMES = {
    "degraded": "Share of the cell first degraded since {first} (tropical moist forest)",
    "deforested": "Share of the cell first deforested since {first} (tropical moist forest)",
}
LICENSE = (
    "Copernicus / JRC open data, free of charge and without restriction of use. "
    "Source: EC JRC, Tropical Moist Forests v1.2025, re-packaged and aggregated by UNEP/GRID-Geneva. "
    "Cite Vancutsem, C. et al. (2021) Long-term (1990-2019) monitoring of forest cover changes "
    "in the humid tropics. Science Advances 7(10), eabe1603."
)

# A window reader returns the years and the centre coordinates of its pixels.
Window = tuple[np.ndarray, np.ndarray, np.ndarray]
Reader = Callable[[str, str, float, float], Iterator[Window]]


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


def grid(config: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Cell centres, both ascending."""
    box, cell = config["bbox"], config["cell"]
    nx = round((box["east"] - box["west"]) / cell)
    ny = round((box["north"] - box["south"]) / cell)
    lon = box["west"] + cell * (np.arange(nx) + 0.5)
    lat = box["south"] + cell * (np.arange(ny) + 0.5)
    return lat, lon


def years(config: dict[str, Any]) -> np.ndarray:
    return np.arange(config["firstYear"], config["lastYear"] + 1)


def times(config: dict[str, Any]) -> np.ndarray:
    """Each year is stamped at its last day: the state at the end of the year."""
    return np.array([np.datetime64(f"{year}-12-31T00:00", "ns") for year in years(config)])


def accumulate(counts: np.ndarray, totals: np.ndarray, values: np.ndarray, lat: np.ndarray,
               lon: np.ndarray, config: dict[str, Any], south: float, rows: int) -> None:
    """Adds one window of pixels to the per-year counts and the pixel totals of a latitude band.

    `counts` is (year, row, column) for the band whose southern edge is `south`;
    `totals` counts every sampled pixel of a cell, forest or not.
    """
    box, cell = config["bbox"], config["cell"]
    first = config["firstYear"]
    nx = counts.shape[2]
    lat2, lon2 = np.broadcast_to(lat[:, None], values.shape), np.broadcast_to(lon[None, :], values.shape)
    row = np.floor((lat2 - south) / cell).astype(np.int64)
    col = np.floor((lon2 - box["west"]) / cell).astype(np.int64)
    inside = (row >= 0) & (row < rows) & (col >= 0) & (col < nx)
    flat = row[inside] * nx + col[inside]
    if totals is not None:
        totals += np.bincount(flat, minlength=rows * nx).reshape(rows, nx).astype(totals.dtype)
    year = values[inside].astype(np.int64)
    keep = (year >= first) & (year <= config["lastYear"])
    year, flat = year[keep], flat[keep]
    # One count per year present, so no array larger than a band of one year is allocated.
    order = np.argsort(year, kind="stable")
    found, starts = np.unique(year[order], return_index=True)
    for value, part in zip(found, np.split(flat[order], starts[1:])):
        counts[value - first] += np.bincount(part, minlength=rows * nx).reshape(rows, nx).astype(counts.dtype)


def shares(counts: np.ndarray, totals: np.ndarray) -> np.ndarray:
    """Cumulative share of each cell, as int16 codes of SCALE; fill where no pixel was sampled."""
    cumulative = np.cumsum(counts, axis=0, dtype=np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        share = cumulative / totals[None, :, :]
    codes = np.rint(share / SCALE)
    codes[:, totals == 0] = FILL
    return codes.astype(np.int16)


def cog_windows(url: str, overview: int, south: float, north: float) -> Iterator[Window]:
    """The pixels of a COG overview between two latitudes, in blocks of rows."""
    import rasterio
    from rasterio.windows import Window as RasterWindow

    with rasterio.open(url, overview_level=overview) as source:
        transform = source.transform
        top = max(0, int(np.floor((transform.f - north) / -transform.e)))
        bottom = min(source.height, int(np.ceil((transform.f - south) / -transform.e)))
        lon = transform.c + transform.a * (np.arange(source.width) + 0.5)
        for start in range(top, bottom, 2048):
            height = min(2048, bottom - start)
            values = source.read(1, window=RasterWindow(0, start, source.width, height))
            lat = transform.f + transform.e * (np.arange(start, start + height) + 0.5)
            yield values, lat, lon


def tile_overlaps(tile: str, south: float, north: float) -> bool:
    """Tiles are named by their approximate north-west corner and span 10 degrees."""
    top = int(tile.split("_")[0][1:]) * (1 if tile[0] == "N" else -1)
    return top > south - 0.01 and top - 10 < north + 0.01


def band(config: dict[str, Any], product: str, south: float, rows: int, nx: int,
         reader: Reader, *, with_totals: bool) -> tuple[np.ndarray, np.ndarray | None]:
    north = south + rows * config["cell"]
    counts = np.zeros((len(years(config)), rows, nx), dtype=np.uint32)
    totals = np.zeros((rows, nx), dtype=np.uint32) if with_totals else None
    for tile in config["tiles"]:
        if not tile_overlaps(tile, south, north):
            continue
        url = config["sourceUrl"].format(tile=tile, product=product)
        for values, lat, lon in reader(url, str(config["overviewLevel"]), south, north):
            accumulate(counts, totals, values, lat, lon, config, south, rows)
    return counts, totals


def dataset(config: dict[str, Any], lat: np.ndarray, lon: np.ndarray,
            data: dict[str, np.ndarray]) -> xr.Dataset:
    """Decoded values (shares 0–1, NaN as fill) with the store's coordinates and attributes."""
    first = config["firstYear"]
    variables = {}
    for name, codes in data.items():
        values = np.where(codes == FILL, np.nan, codes.astype(np.float32) * np.float32(SCALE))
        variables[name] = xr.Variable(
            ("time", "latitude", "longitude"), values,
            attrs={"long_name": LONG_NAMES[name].format(first=first), "units": "1",
                   "valid_min": 0.0, "valid_max": 1.0},
        )
    result = xr.Dataset(variables, coords={"time": times(config), "latitude": lat, "longitude": lon})
    result["latitude"].attrs = {"standard_name": "latitude", "units": "degrees_north"}
    result["longitude"].attrs = {"standard_name": "longitude", "units": "degrees_east"}
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    result.attrs = {
        "title": f"Tropical moist forest degraded and deforested since {first}, Congo Basin",
        "source": "EC JRC Tropical Moist Forests v1.2025, DegradationYear and DeforestationYear "
                  "(https://forobs.jrc.ec.europa.eu/TMF), COG mirror https://source.coop/epoch/jrc-tmf",
        "license": LICENSE,
        "history": f"{stamp}: share of the 30 m pixels of each {config['cell']} degree cell, "
                   f"sampled at COG overview {config['overviewLevel']} (nearest), "
                   "by zartigl scripts/to_zarr/jrc/tmf",
        "references": "https://doi.org/10.1126/sciadv.abe1603",
    }
    return result


def encodings(names: list[str]) -> dict[str, dict[str, Any]]:
    from numcodecs import Blosc

    compressor = Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE)
    result: dict[str, dict[str, Any]] = {
        "time": {"units": "hours since 1981-01-01 00:00:00", "calendar": "standard", "dtype": "int32"},
    }
    for name in names:
        result[name] = {"dtype": "int16", "_FillValue": FILL, "scale_factor": SCALE,
                        "compressors": (compressor,)}
    return result


def completed(target: common.Target) -> list[str]:
    """The stores whose build finished: `build` sets their `completed` attribute last."""
    import zarr

    done = []
    for name in common.STORE_NAMES:
        try:
            group = zarr.open_consolidated(target.store(name), zarr_format=2, mode="r")
        except (FileNotFoundError, KeyError, ValueError):
            continue
        if "completed" in group.attrs:
            done.append(name)
    return done


def mark_completed(target: common.Target, stamp: str) -> None:
    import zarr

    for name in common.STORE_NAMES:
        group = zarr.open_group(target.store(name), zarr_format=2, mode="r+")
        group.attrs["completed"] = stamp
        zarr.consolidate_metadata(target.store(name), zarr_format=2)


def build(config: dict[str, Any], target: common.Target, *, rows: int = 600,
          reader: Reader | None = None, overwrite: bool = False) -> None:
    """Writes both stores band by band; each band is a whole number of store chunks.

    The stores list every year from the start, empty until their band is written, so a store is
    only usable once `completed` is set, last. `overwrite` replaces existing stores.
    """
    read = reader or (lambda url, overview, south, north: cog_windows(url, int(overview), south, north))
    lat, lon = grid(config)
    names = list(config["variables"])
    specs = encodings(names)
    for name, chunks in config["stores"].items():
        if rows % chunks["latitude"]:
            raise ValueError(f"{name}: --rows must be a multiple of {chunks['latitude']}")
    template = dataset(config, lat, lon, {
        name: np.full((len(years(config)), len(lat), len(lon)), FILL, dtype=np.int16) for name in names
    })
    contract.require(template, specs)
    for store, chunks in config["stores"].items():
        encoding = {name: {**specs[name], "chunks": (chunks["time"], chunks["latitude"], chunks["longitude"])}
                    for name in names}
        encoding["time"] = {**specs["time"], "chunks": (common.TIME_COORDINATE_CHUNK,)}
        template.chunk({"time": chunks["time"], "latitude": chunks["latitude"],
                        "longitude": chunks["longitude"]}).to_zarr(
                         target.store(store), mode="w" if overwrite else "w-", compute=False, consolidated=True,
                         zarr_format=2, encoding=encoding, write_empty_chunks=False)
    for start in range(0, len(lat), rows):
        count = min(rows, len(lat) - start)
        south = config["bbox"]["south"] + start * config["cell"]
        data, totals = {}, None
        for name in names:
            counts, band_totals = band(config, config["variables"][name], south, count, len(lon), read,
                                       with_totals=totals is None)
            totals = band_totals if totals is None else totals
            data[name] = shares(counts, totals)
        part = dataset(config, lat[start:start + count], lon, data).drop_vars(["time", "longitude"])
        part = part.drop_vars("latitude")
        for store in config["stores"]:
            part.to_zarr(target.store(store), region={"latitude": slice(start, start + count)},
                         zarr_format=2, write_empty_chunks=False)
        print(f"rows {start}–{start + count} of {len(lat)} written", flush=True)
    mark_completed(target, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))


def plan(config: dict[str, Any], target: common.Target) -> str:
    done = completed(target)
    if len(done) == len(common.STORE_NAMES):
        return f"{config['prefix']}: complete, {config['firstYear']}–{config['lastYear']}; nothing to do"
    if done or common.stored_times(target, "timeChunked").size:
        return f"{config['prefix']}: unfinished build; run rebuilds it"
    return f"{config['prefix']}: missing; run builds {config['firstYear']}–{config['lastYear']}"


def run(config: dict[str, Any], target: common.Target, *, rows: int = 600, rebuild: bool = False,
        reader: Reader | None = None) -> None:
    """Builds the stores when they are missing or unfinished, or always with `rebuild`.

    The product is static: a new JRC release goes to a new `prefix` (version) in config.json,
    which this command then builds; stores of earlier versions are left as they are.
    """
    done = completed(target)
    if not rebuild and len(done) == len(common.STORE_NAMES):
        print(plan(config, target), flush=True)
        return
    exists = bool(done) or common.stored_times(target, "timeChunked").size > 0
    build(config, target, rows=rows, reader=reader, overwrite=rebuild or exists)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (("plan", "say whether the stores need a build"),
                       ("run", "build the stores when missing or unfinished"),
                       ("sync-geo", "nothing to do: run writes both stores")):
        command = commands.add_parser(name, help=text)
        command.add_argument("--local", help="use this directory instead of the bucket")
        command.add_argument("--budget", type=common.parse_budget, default="24h",
                             help="accepted for the shared workflow; a build is not split")
        command.add_argument("--force", action="store_true", help="accepted for the shared workflow")
        if name == "run":
            command.add_argument("--rows", type=int, default=600, help="latitude rows per band")
            command.add_argument("--rebuild", action="store_true", help="replace complete stores too")
    args = parser.parse_args()
    config = load_config()
    if args.command == "sync-geo":
        print("geoChunked.zarr is written by run", flush=True)
        return
    target = common.target_from_args(args, config["prefix"])
    if args.command == "plan":
        print(plan(config, target), flush=True)
    else:
        run(config, target, rows=args.rows, rebuild=args.rebuild)


if __name__ == "__main__":
    main()
