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
  uv run scripts/to_zarr/noaa/crw_dhw/convert.py plan [--local DIR]
  uv run scripts/to_zarr/noaa/crw_dhw/convert.py run [--budget 5h] [--jobs 4] [--local DIR]
  uv run scripts/to_zarr/noaa/crw_dhw/convert.py sync-geo [--budget 5h] [--force] [--local DIR]

Without --local, stores are written to `prefix` of the bucket configured in
.env.demo / .env / the environment (S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET).
"""

from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import common  # noqa: E402
from common import Product, as_day, pending_days, sync_geo  # noqa: E402,F401

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
FILL = -32768
# Kept from the CRW files; everything else (mask, crs, ACDD boilerplate) is dropped.
VARIABLE_ATTRS = ("long_name", "units")
GLOBAL_ATTRS = ("title", "institution", "source", "references", "license", "acknowledgement", "product_version")


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


def source_url(config: dict[str, Any], family: str, day: date) -> str:
    return config["sourceUrl"].format(family=family, year=day.year, date=day.strftime("%Y%m%d"))


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
    dataset.attrs = {**attrs, "history": "Converted from the CRW daily netCDF files by zartigl scripts/to_zarr"}
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


def to_store(dataset: xr.Dataset) -> tuple[xr.Dataset, dict[str, dict[str, Any]]]:
    specs = encodings(dataset)
    return without_source_attrs(dataset), specs


def release(paths: dict[str, Path]) -> None:
    for path in paths.values():
        path.unlink()


def product() -> Product:
    return Product("crw-dhw", fetch_day=fetch_day, read_day=lambda paths, _day: read_day(paths),
                   to_store=to_store, release=release)


def run(args: argparse.Namespace, config: dict[str, Any]) -> None:
    common.run(args, config, product())


if __name__ == "__main__":
    common.main(__doc__, CONFIG_PATH, lambda _config: product())
