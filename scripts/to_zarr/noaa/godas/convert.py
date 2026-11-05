#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.35",
#   "dask[array]>=2025.1",
#   "fsspec>=2025.3",
#   "netcdf4>=1.7",
#   "numcodecs>=0.15",
#   "numpy>=2.0",
#   "requests>=2.32",
#   "s3fs>=2025.3",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""NCEP GODAS monthly ocean potential temperature (NOAA PSL) → Zarr on the zartigl bucket.

GODAS, the NCEP Global Ocean Data Assimilation System, gives monthly means of
potential temperature on 40 levels from 5 m to 4478 m, on a 1° (longitude)
by 1/3° (latitude) grid from 74.5° S to 64.5° N. NOAA PSL publishes one file
per year (`pottmp.<year>.nc`, the bias-corrected files) and rewrites the file
of the current year when a month is added, about two weeks after the month
ends. Months are stamped at their first day, as in the source.

One store holds three variables on the same time axis and grid:

- `pottmp` (time, depth, latitude, longitude): potential temperature in degC
  (the source is in Kelvin), longitudes rolled from 0…360 to −180…180;
- `t300` (time, latitude, longitude): mean potential temperature of the upper
  300 m, weighted by layer thickness; fill where the water column does not
  reach 300 m. A proxy of the upper-ocean heat content;
- `d20` (time, latitude, longitude): depth of the 20 degC isotherm (the
  thermocline in the tropics), linearly interpolated between levels; fill
  where the surface is below 20 degC or the column never cools below it.

These are absolute values, not anomalies, and this is not the CPC pentad
"Sub-Surface Temperature Departures in the Equatorial Pacific" product.

`run` reads the year files from the year of the last stored month (or
`firstYear`) on and appends the months each store lacks, to `timeChunked.zarr`
and `geoChunked.zarr` together. A stored month is never rewritten: PSL
revisions of past months need a new store version. The nightly workflow
(.github/workflows/to-zarr.yml) calls the same commands as for the daily
products, and `run` does nothing until PSL adds a month.

Usage:
  uv run scripts/to_zarr/noaa/godas/convert.py plan [--local DIR]
  uv run scripts/to_zarr/noaa/godas/convert.py run [--budget 90m] [--max-years N] [--local DIR]
  uv run scripts/to_zarr/noaa/godas/convert.py sync-geo   # no-op: run writes geoChunked too

Without --local, stores are written to `prefix` of the bucket configured in
.env.demo / .env / the environment (S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET).

Licence: NOAA data in the public domain; acknowledge "GODAS data provided by
the NOAA PSL, Boulder, Colorado, USA, from their website at https://psl.noaa.gov".
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
from typing import Any, Callable

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import common  # noqa: E402
import contract  # noqa: E402

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
FILL = -32768
SCALES = {"pottmp": 0.002, "t300": 0.002, "d20": 0.1}
KELVIN = 273.15
UPPER_DEPTH = 300.0
ISOTHERM = 20.0
LICENSE = (
    "NOAA data, in the public domain. Acknowledge: GODAS data provided by the NOAA PSL, Boulder, "
    "Colorado, USA, from their website at https://psl.noaa.gov. Cite Behringer, D.W. and Y. Xue (2004) "
    "Evaluation of the global ocean data assimilation system at NCEP: The Pacific Ocean. Eighth Symposium "
    "on Integrated Observing and Assimilation Systems for Atmosphere, Oceans, and Land Surface, AMS 84th "
    "Annual Meeting. Re-packaged by UNEP/GRID-Geneva."
)

# Downloads the year file into a directory, or returns None when PSL has not published it (404).
Fetcher = Callable[[dict[str, Any], int, Path], Path | None]


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


def download(url: str, destination: Path) -> Path | None:
    """The file, or None when PSL has not published it (404)."""
    import requests

    with requests.get(url, stream=True, timeout=120) as response:
        if response.status_code == 404:
            return None
        response.raise_for_status()
        partial = destination.with_suffix(".partial")
        with partial.open("wb") as handle:
            for block in response.iter_content(1 << 20):
                handle.write(block)
        partial.rename(destination)
    return destination


def fetch_year(config: dict[str, Any], year: int, directory: Path) -> Path | None:
    return download(config["sourceUrl"].format(year=year), directory / f"pottmp.{year}.nc")


def read_year(path: Path) -> xr.DataArray:
    """Potential temperature of a year file in degC, as (time, depth, latitude, longitude) in the store layout."""
    with xr.open_dataset(path) as source:
        kelvin = source["pottmp"].load()
    kelvin = kelvin.rename(level="depth", lat="latitude", lon="longitude")
    lon = kelvin["longitude"].values.astype(np.float64)
    kelvin = kelvin.assign_coords(
        time=kelvin["time"].values.astype("datetime64[D]").astype("datetime64[ns]"),
        depth=kelvin["depth"].values.astype(np.float64),
        latitude=np.round(kelvin["latitude"].values.astype(np.float64), 4),
        longitude=np.where(lon > 180, lon - 360, lon),
    ).sortby("longitude")
    return (kelvin - KELVIN).astype(np.float32)


def layer_edges(depth: np.ndarray) -> np.ndarray:
    """Layer boundaries around level centres: the surface, the midpoints, and as far below the last level."""
    middle = (depth[1:] + depth[:-1]) / 2
    return np.concatenate([[0.0], middle, [depth[-1] + (depth[-1] - depth[-2]) / 2]])


def upper_mean(temperature: np.ndarray, depth: np.ndarray, bottom: float = UPPER_DEPTH) -> np.ndarray:
    """Thickness-weighted mean of (time, depth, lat, lon) from the surface to `bottom`, NaN where a layer is missing."""
    edges = layer_edges(depth)
    thickness = np.clip(np.minimum(edges[1:], bottom) - edges[:-1], 0, None)
    used = thickness > 0
    weights = thickness[used] / thickness[used].sum()
    return np.einsum("k,tkyx->tyx", weights, temperature[:, used]).astype(np.float32)


def isotherm_depth(temperature: np.ndarray, depth: np.ndarray, value: float = ISOTHERM) -> np.ndarray:
    """Depth where (time, depth, lat, lon) first cools below `value`, interpolated between levels.

    NaN where the top level is already colder, or the column (down to its last valid level) never cools below.
    """
    with np.errstate(invalid="ignore"):
        warm = temperature >= value
        cold = temperature < value
    crossing = warm[:, :-1] & cold[:, 1:]
    found = crossing.any(axis=1) & warm[:, 0]
    upper = crossing.argmax(axis=1)[:, None]
    t_upper = np.take_along_axis(temperature, upper, axis=1)[:, 0]
    t_lower = np.take_along_axis(temperature, upper + 1, axis=1)[:, 0]
    d_upper, d_lower = depth[upper[:, 0]], depth[upper[:, 0] + 1]
    with np.errstate(invalid="ignore", divide="ignore"):
        result = d_upper + (t_upper - value) / (t_upper - t_lower) * (d_lower - d_upper)
    return np.where(found, result, np.nan).astype(np.float32)


def history_line(times: np.ndarray) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    first, last = (str(value)[:7] for value in (times[0], times[-1]))
    return (f"{stamp}: months {first} to {last} from NOAA PSL pottmp.<year>.nc; Kelvin to degC, "
            f"longitude rolled from 0…360 to −180…180; t300 is the thickness-weighted mean over "
            f"0–{UPPER_DEPTH:g} m, d20 the linearly interpolated {ISOTHERM:g} degC isotherm depth; "
            "by zartigl scripts/to_zarr/noaa/godas")


def dataset(pottmp: xr.DataArray) -> xr.Dataset:
    """The store variables of some months, decoded (degC, metres, NaN as fill), with the store attributes."""
    depth = pottmp["depth"].values
    values = pottmp.values
    result = xr.Dataset(
        {
            "pottmp": (contract.DEPTH_DIMS, values, {
                "long_name": "Sea water potential temperature (GODAS monthly mean)",
                "units": "degC",
            }),
            "t300": (contract.DIMS, upper_mean(values, depth), {
                "long_name": f"Mean sea water potential temperature of the upper {UPPER_DEPTH:g} m (GODAS monthly mean)",
                "units": "degC",
                "comment": "Thickness-weighted over the GODAS levels; a proxy of the upper-ocean heat content. "
                           "Fill where the water column is shallower than 300 m",
            }),
            "d20": (contract.DIMS, isotherm_depth(values, depth), {
                "long_name": f"Depth of the {ISOTHERM:g} degC isotherm (GODAS monthly mean)",
                "units": "m",
                "comment": "Linearly interpolated between level centres; fill where the surface is below "
                           "20 degC or the water column never cools below it",
            }),
        },
        coords={"time": pottmp["time"].values, "depth": depth,
                "latitude": pottmp["latitude"].values, "longitude": pottmp["longitude"].values},
    )
    result["depth"].attrs = {"standard_name": "depth", "long_name": "Depth of the level centre",
                             "units": "m", "positive": "down"}
    result["latitude"].attrs = {"standard_name": "latitude", "units": "degrees_north"}
    result["longitude"].attrs = {"standard_name": "longitude", "units": "degrees_east"}
    result.attrs = {
        "title": "GODAS monthly ocean potential temperature, upper 300 m mean temperature "
                 "and 20 degC isotherm depth",
        "source": "NCEP Global Ocean Data Assimilation System (GODAS), monthly means, bias-corrected files "
                  "from NOAA PSL (https://psl.noaa.gov/data/gridded/data.godas.html)",
        "license": LICENSE,
        "history": history_line(pottmp["time"].values),
        "comment": "Absolute values, not anomalies. Months are stamped at their first day. Not the CPC pentad "
                   "Sub-Surface Temperature Departures in the Equatorial Pacific product.",
        "references": "https://www.cpc.ncep.noaa.gov/products/GODAS/",
    }
    return result


def encodings(names: list[str]) -> dict[str, dict[str, Any]]:
    from numcodecs import Blosc

    compressor = Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE)
    result: dict[str, dict[str, Any]] = {
        "time": {"units": "hours since 1980-01-01 00:00:00", "calendar": "standard", "dtype": "int32"},
    }
    for name in names:
        result[name] = {"dtype": "int16", "_FillValue": FILL, "scale_factor": SCALES[name],
                        "compressors": (compressor,)}
    return result


def last_stored(target: common.Target) -> dict[str, np.datetime64 | None]:
    """The last month of each store, None for a store that does not exist yet."""
    result = {}
    for name in common.STORE_NAMES:
        times = common.stored_times(target, name)
        result[name] = times[-1] if times.size else None
    return result


def next_month(value: np.datetime64) -> np.datetime64:
    return (value.astype("datetime64[M]") + np.timedelta64(1, "M")).astype("datetime64[ns]")


def pending_years(config: dict[str, Any], target: common.Target, today: date | None = None) -> list[int]:
    """Years whose file may hold months a store lacks: from the earliest last stored month on."""
    lasts = list(last_stored(target).values())
    if any(value is None for value in lasts):
        first = config["firstYear"]
    else:
        first = int(str(min(next_month(value) for value in lasts))[:4])
    return list(range(first, (today or date.today()).year + 1))


def write_months(config: dict[str, Any], target: common.Target, data: xr.DataArray) -> list[str]:
    """Appends to each store the months after its last one; the stores keep one time axis, without holes."""
    written = []
    for store, chunks in config["stores"].items():
        times = common.stored_times(target, store)
        start = next_month(times[-1]) if times.size else np.datetime64(f"{config['firstYear']}-01-01", "ns")
        months = data.isel(time=data["time"].values >= start)
        if not months.sizes["time"]:
            continue
        first = start.astype("datetime64[M]")
        expected = np.arange(first, first + np.timedelta64(months.sizes["time"], "M"))
        if not np.array_equal(months["time"].values.astype("datetime64[M]"), expected):
            raise RuntimeError(f"{store}: months {months['time'].values} do not follow {str(start)[:7]} without a hole")
        part = dataset(months)
        if times.size:
            part.attrs["history"] = history_line(np.concatenate([times[:1], months["time"].values[-1:]]))
        specs = encodings(list(part.data_vars))
        sizes = {dim: chunks[dim] for dim in ("depth", "latitude", "longitude")}
        steps = common.append_chunks(times.size, part.sizes["time"], chunks["time"])
        common.write(part.chunk({"time": steps, **sizes}), target, store, chunks, specs, append=bool(times.size))
        written.append(f"{store}: {str(months['time'].values[0])[:7]} to {str(months['time'].values[-1])[:7]}")
    return written


def plan(config: dict[str, Any], target: common.Target, today: date | None = None) -> str:
    lasts = last_stored(target)
    have = ", ".join(f"{name} until {str(value)[:7]}" if value is not None else f"{name} missing"
                     for name, value in lasts.items())
    years = pending_years(config, target, today)
    return f"{config['prefix']}: {have}; run reads {years[0]}–{years[-1]}"


def run(config: dict[str, Any], target: common.Target, *, today: date | None = None,
        fetch: Fetcher = fetch_year, budget: float = float("inf"), max_years: int | None = None) -> None:
    """Appends to both stores the months they lack, year file by year file, until the budget is spent.

    The year file of the current year may be missing (January), any earlier one may not.
    """
    today = today or date.today()
    deadline = time.monotonic() + budget
    years = pending_years(config, target, today)[:max_years]
    for year in years:
        if time.monotonic() > deadline:
            print(f"Budget reached before {year}", flush=True)
            break
        workdir = Path(tempfile.mkdtemp(prefix=f"godas-{year}-"))
        try:
            path = fetch(config, year, workdir)
            if path is None:
                if year >= today.year:
                    print(f"{year} not published yet", flush=True)
                    break
                raise RuntimeError(f"pottmp.{year}.nc is missing")
            written = write_months(config, target, read_year(path))
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        print(f"{year}: " + ("; ".join(written) or "no new month"), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (("plan", "show the stored months and the year files to read"),
                       ("run", "append the new months to both stores"),
                       ("sync-geo", "nothing to do: run writes both stores")):
        command = commands.add_parser(name, help=text)
        command.add_argument("--local", help="use this directory instead of the bucket")
        command.add_argument("--budget", type=common.parse_budget, default="5h",
                             help="time after which no new year file starts")
        command.add_argument("--force", action="store_true", help="accepted for the shared workflow")
        if name == "run":
            command.add_argument("--max-years", type=int, help="stop after this many year files")
    args = parser.parse_args()
    config = load_config()
    if args.command == "sync-geo":
        print("geoChunked.zarr is written by run", flush=True)
        return
    target = common.target_from_args(args, config["prefix"])
    if args.command == "plan":
        print(plan(config, target), flush=True)
    else:
        run(config, target, budget=args.budget, max_years=args.max_years)


if __name__ == "__main__":
    main()
