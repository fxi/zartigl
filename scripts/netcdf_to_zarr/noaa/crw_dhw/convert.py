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
"""NOAA Coral Reef Watch daily 5 km heat stress (v3.1) → Zarr on the zartigl bucket.

Each day of the four CRW products (degree heating week, bleaching alert area,
SST anomaly, hotspot) is downloaded, flipped to ascending latitude and appended
to `timeChunked.zarr`. `sync-geo` then appends the same days to
`geoChunked.zarr` once they lag by `geoSyncMinLagDays`, because each append
rewrites every tile of the open time chunk. Values keep CRW's int16 encoding.

Usage:
  uv run scripts/netcdf_to_zarr/noaa/crw_dhw/convert.py plan [--local DIR]
  uv run scripts/netcdf_to_zarr/noaa/crw_dhw/convert.py run [--budget 5h] [--jobs 4] [--local DIR]
  uv run scripts/netcdf_to_zarr/noaa/crw_dhw/convert.py sync-geo [--budget 5h] [--force] [--local DIR]

Without --local, stores are written to `prefix` of the bucket configured in
.env.demo / .env / the environment (S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET).
"""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
from typing import Any

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from common import (  # noqa: E402
    Target,
    append_chunks,
    open_store,
    parse_budget,
    stored_times,
    target_from_args,
    write,
)

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
FILL = -32768
# Kept from the CRW files; everything else (mask, crs, ACDD boilerplate) is dropped.
VARIABLE_ATTRS = ("long_name", "units")
GLOBAL_ATTRS = ("title", "institution", "source", "references", "license", "acknowledgement", "product_version")


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


def source_url(config: dict[str, Any], family: str, day: date) -> str:
    return config["sourceUrl"].format(family=family, year=day.year, date=day.strftime("%Y%m%d"))


def as_day(value: np.datetime64) -> date:
    return value.astype("datetime64[D]").astype(date)


def pending_days(stored: np.ndarray, start: date, today: date) -> list[date]:
    """Days after the last stored one (or from `start`) up to yesterday; the store never has holes."""
    first = as_day(stored[-1]) + timedelta(days=1) if stored.size else start
    return [first + timedelta(days=offset) for offset in range((today - first).days)]


def encodings(dataset: xr.Dataset) -> dict[str, dict[str, Any]]:
    from numcodecs import Blosc

    compressor = Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE)
    result: dict[str, dict[str, Any]] = {
        "time": {"units": "hours since 1981-01-01 00:00:00", "calendar": "standard", "dtype": "int32"},
    }
    for name, variable in dataset.data_vars.items():
        scale = variable.attrs.get("scale_factor_source", 1)
        result[name] = {
            "dtype": "int16",
            "_FillValue": FILL,
            "compressors": (compressor,),
            **({"scale_factor": float(scale)} if scale != 1 else {}),
        }
    return result


def read_day(paths: dict[str, Path]) -> xr.Dataset:
    """One CRW day as (time, latitude, longitude) with ascending latitude and decoded values."""
    variables = {}
    attrs: dict[str, Any] = {}
    for name, path in paths.items():
        # Decoded by hand: xarray cannot mask the uint8 alert levels, whose scale_factor is an integer.
        with xr.open_dataset(path, engine="netcdf4", mask_and_scale=False) as source:
            raw = source[name].load()
            scale = raw.attrs.get("scale_factor", 1)
            values = raw.values.astype(np.float32)
            values[raw.values == raw.attrs["_FillValue"]] = np.nan
            variable = raw.copy(data=values * np.float32(scale))
            variable.attrs = {
                **{key: variable.attrs[key] for key in VARIABLE_ATTRS if key in variable.attrs},
                **{key: float(variable.attrs[key]) * float(scale)
                   for key in ("valid_min", "valid_max") if key in variable.attrs},
                "scale_factor_source": float(scale),
            }
            variables[name] = variable
            attrs = attrs or {key: source.attrs[key] for key in GLOBAL_ATTRS if key in source.attrs}
    dataset = xr.Dataset(variables).drop_vars(["crs", "mask"], errors="ignore")
    dataset = dataset.rename({"lat": "latitude", "lon": "longitude"}).sortby("latitude")
    dataset["latitude"].attrs = {"standard_name": "latitude", "units": "degrees_north"}
    dataset["longitude"].attrs = {"standard_name": "longitude", "units": "degrees_east"}
    dataset.attrs = {**attrs, "history": "Converted from the CRW daily netCDF files by zartigl scripts/netcdf_to_zarr"}
    return dataset


def without_source_attrs(dataset: xr.Dataset) -> xr.Dataset:
    for variable in dataset.data_vars.values():
        variable.attrs.pop("scale_factor_source", None)
    return dataset


def download(url: str, destination: Path) -> Path | None:
    """The file, or None when CRW has not published it (404)."""
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


def fetch_day(config: dict[str, Any], day: date, directory: Path) -> dict[str, Path] | None:
    paths = {}
    for name, family in config["variables"].items():
        path = download(source_url(config, family, day), directory / f"{family}_{day:%Y%m%d}.nc")
        if path is None:
            return None
        paths[name] = path
    return paths


def append_day(target: Target, config: dict[str, Any], dataset: xr.Dataset, first: bool) -> None:
    chunks = config["stores"]["timeChunked"]
    specs = encodings(dataset)
    dataset = without_source_attrs(dataset).chunk(chunks)
    write(dataset, target, "timeChunked", chunks, specs, append=not first)


def run(args: argparse.Namespace, config: dict[str, Any]) -> None:
    target = target_from_args(args, config["prefix"])
    today = datetime.now(timezone.utc).date()
    stored = stored_times(target, "timeChunked")
    days = pending_days(stored, date.fromisoformat(config["start"]), today)[:args.max_days]
    deadline = time.monotonic() + args.budget
    recent = today - timedelta(days=config["publicationDelayDays"])
    written = 0
    workdir = Path(tempfile.mkdtemp(prefix="crw-dhw-"))
    try:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futures: dict[date, Future] = {}
            for index, day in enumerate(days):
                for ahead in days[index:index + args.jobs]:
                    if ahead not in futures:
                        futures[ahead] = pool.submit(fetch_day, config, ahead, workdir)
                if time.monotonic() > deadline:
                    print(f"Budget reached before {day}", flush=True)
                    break
                paths = futures.pop(day).result()
                if paths is None:
                    if day >= recent:
                        print(f"{day} not published yet", flush=True)
                        break
                    raise RuntimeError(f"CRW file missing for {day}, which is older than the publication delay")
                append_day(target, config, read_day(paths), first=stored.size == 0 and written == 0)
                for path in paths.values():
                    path.unlink()
                written += 1
                print(f"{day} appended", flush=True)
            for future in futures.values():
                future.cancel()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    print(json.dumps({"appended": written, "store": target.public_url("timeChunked")}))


def sync_geo(args: argparse.Namespace, config: dict[str, Any]) -> None:
    """Append to geoChunked.zarr the days timeChunked.zarr already holds, one store time chunk at a time."""
    import dask

    target = target_from_args(args, config["prefix"])
    source_times = stored_times(target, "timeChunked")
    geo_times = stored_times(target, "geoChunked")
    if not np.array_equal(source_times[:geo_times.size], geo_times):
        raise RuntimeError("geoChunked.zarr is not a prefix of timeChunked.zarr; rebuild it")
    lag = source_times.size - geo_times.size
    if lag == 0 or (lag < config["geoSyncMinLagDays"] and not args.force):
        print(json.dumps({"appended": 0, "lag": int(lag)}))
        return
    chunks = config["stores"]["geoChunked"]
    source = open_store(target, "timeChunked")
    specs = encodings(source.assign(**{
        name: variable.assign_attrs(scale_factor_source=variable.encoding.get("scale_factor", 1))
        for name, variable in source.data_vars.items()
    }))
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
            print(f"geoChunked: {start}/{source_times.size} days", flush=True)
    print(json.dumps({"appended": start - geo_times.size, "store": target.public_url("geoChunked")}))


def plan(args: argparse.Namespace, config: dict[str, Any]) -> None:
    target = target_from_args(args, config["prefix"])
    today = datetime.now(timezone.utc).date()
    stored = stored_times(target, "timeChunked")
    geo = stored_times(target, "geoChunked")
    days = pending_days(stored, date.fromisoformat(config["start"]), today)
    print(json.dumps({
        "timeChunked": {"days": int(stored.size), "last": str(as_day(stored[-1])) if stored.size else None},
        "geoChunked": {"days": int(geo.size)},
        "pending": {"days": len(days), "first": str(days[0]) if days else None},
    }, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "run", "sync-geo"):
        command = commands.add_parser(name)
        command.add_argument("--local", help="Write stores to this directory instead of the bucket")
        command.add_argument("--config", type=Path, default=CONFIG_PATH)
        if name != "plan":
            command.add_argument("--budget", type=parse_budget, default=parse_budget("5h"),
                                 help="Time after which no new day or chunk starts")
            command.add_argument("--jobs", type=int, default=4)
        if name == "run":
            command.add_argument("--max-days", type=int, help="Stop after this many days")
        if name == "sync-geo":
            command.add_argument("--force", action="store_true", help="Sync even below geoSyncMinLagDays")
    args = parser.parse_args()
    config = load_config(args.config)
    {"plan": plan, "run": run, "sync-geo": sync_geo}[args.command](args, config)


if __name__ == "__main__":
    main()
