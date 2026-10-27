"""CAMS products from the Copernicus Atmosphere Data Store (ADS) → Zarr on the zartigl bucket.

One module serves every CAMS product; each product directory only holds a
`config.json` and a thin `convert.py`. The config names the ADS dataset, the
base request, the variables and how each one is stored:

- `variables.<store name>`: `request` (the ADS variable), `source` (its short
  name in the netCDF), `factor` and `offset` (unit conversion applied before
  storing, value × factor + offset),
  `units`, `longName`, and either `scaleFactor` (int16) or `dtype: "float32"`.
  `zeroAsFill` stores exact zeros as missing (no fire, no plume), so empty
  chunks are not written and the map stays transparent there.
- `grid`: the fixed store grid. Each day is snapped onto it, or linearly
  interpolated when the provider changes resolution, so one store never mixes
  grids.
- `timeShiftHours`: moves provider time stamps onto the day they describe.
  GFAS daily means are stamped at the end of their window (D+1 00:00), so
  −12 puts them at D 12:00.
- `requestDays`: days fetched per ADS request. Data older than 30 days is on
  tape, where one request for many days is far faster than many small ones.

ADS answers with netCDF (GFAS) or zipped netCDF (forecasts), in one of two
layouts: `valid_time` (analyses) or `forecast_reference_time` × `forecast_period`
(forecasts). Both become (time, latitude, longitude) with ascending latitude
and longitude in −180…180. The last available date comes from the public ADS
catalogue, so a day that is not published yet is never requested.

The ADS key comes from `ADS_KEY` (the environment or .env) or from ~/.cdsapirc.
"""

from __future__ import annotations

from datetime import date, timedelta
import json
import os
from pathlib import Path
import sys
import threading
from typing import Any
import zipfile

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common  # noqa: E402
from common import Product  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from s3_bucket import ROOT, read_dotenv  # noqa: E402

ADS_URL = "https://ads.atmosphere.copernicus.eu/api"
FILL_INT16 = -32768
TIME_UNITS = "hours since 1970-01-01 00:00:00"
LICENSE = (
    "Generated using Copernicus Atmosphere Monitoring Service information {year}. "
    "Neither the European Commission nor ECMWF is responsible for any use that may be made of the "
    "Copernicus information or data it contains. https://atmosphere.copernicus.eu/"
)


def load_config(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def last_available(dataset: str) -> date:
    """End of the dataset's temporal extent in the public ADS catalogue."""
    import requests

    response = requests.get(f"{ADS_URL}/catalogue/v1/collections/{dataset}", timeout=60)
    response.raise_for_status()
    end = response.json()["extent"]["temporal"]["interval"][0][1]
    return date.fromisoformat(end[:10])


def request_range(config: dict[str, Any], day: date, last: date) -> tuple[date, date]:
    """The block of `requestDays` days, aligned on the store start, that holds `day`, clipped to `last`."""
    size = int(config.get("requestDays", 1))
    start = date.fromisoformat(config["start"])
    first = start + timedelta(days=(day - start).days // size * size)
    return first, min(first + timedelta(days=size - 1), last)


def ads_request(config: dict[str, Any], first: date, last: date) -> dict[str, Any]:
    return {
        **config["request"],
        "variable": [spec["request"] for spec in config["variables"].values()],
        "date": [f"{first:%Y-%m-%d}/{last:%Y-%m-%d}"],
    }


def ads_client() -> Any:
    import cdsapi

    key = os.environ.get("ADS_KEY") or read_dotenv(ROOT / ".env").get("ADS_KEY")
    options = {"url": ADS_URL, "key": key} if key else {"url": ADS_URL}
    return cdsapi.Client(quiet=True, progress=False, **options)


def unpack(download: Path) -> list[Path]:
    """The netCDF files of an ADS download, which is a netCDF or a zip of them."""
    if not zipfile.is_zipfile(download):
        return [download]
    directory = download.with_suffix("")
    with zipfile.ZipFile(download) as archive:
        archive.extractall(directory)
    download.unlink()
    return sorted(directory.rglob("*.nc"))


class Fetcher:
    """Fetches request blocks once and shares them between the days they hold.

    `fetch_day` runs in the driver's worker threads, so each block has its own
    lock; the block files are removed with the work directory at the end of the run.
    """

    def __init__(self, retrieve: Any = None) -> None:
        self._retrieve = retrieve
        self._last: date | None = None
        self._lock = threading.Lock()
        self._blocks: dict[tuple[date, date], tuple[threading.Lock, list[Path]]] = {}

    def last(self, config: dict[str, Any]) -> date:
        with self._lock:
            if self._last is None:
                self._last = last_available(config["dataset"])
            return self._last

    def retrieve(self, config: dict[str, Any], first: date, last: date, destination: Path) -> None:
        if self._retrieve is None:
            self._retrieve = ads_client().retrieve
        self._retrieve(config["dataset"], ads_request(config, first, last), str(destination))

    def __call__(self, config: dict[str, Any], day: date, directory: Path) -> list[Path] | None:
        last = self.last(config)
        if day > last:
            return None
        block = request_range(config, day, last)
        with self._lock:
            lock, paths = self._blocks.setdefault(block, (threading.Lock(), []))
        with lock:
            if not paths:
                destination = directory / f"{config['dataset']}_{block[0]:%Y%m%d}_{block[1]:%Y%m%d}.download"
                self.retrieve(config, *block, destination)
                paths.extend(unpack(destination))
        return paths


def as_valid_time(dataset: xr.Dataset) -> xr.Dataset:
    """Forecast (reference time × lead time) or analysis layouts as a single `time` dimension."""
    if "forecast_reference_time" in dataset.dims or "forecast_period" in dataset.dims:
        dataset = dataset.expand_dims([dim for dim in ("forecast_reference_time", "forecast_period")
                                       if dim not in dataset.dims])
        dataset = dataset.stack(time=("forecast_reference_time", "forecast_period"))
        valid = dataset["valid_time"].values
        dataset = dataset.drop_vars(["time", "forecast_reference_time", "forecast_period", "valid_time"])
        return dataset.assign_coords(time=("time", valid))
    name = "valid_time" if "valid_time" in dataset.dims else "time"
    return dataset.rename({name: "time"}) if name != "time" else dataset


def grid_axis(spec: list[float]) -> np.ndarray:
    first, last, count = spec
    return np.linspace(first, last, int(count))


def on_grid(dataset: xr.Dataset, grid: dict[str, list[float]]) -> tuple[xr.Dataset, bool]:
    """The dataset on the store grid, and whether it had to be interpolated."""
    dataset = dataset.rename({name: target for name, target in (("lat", "latitude"), ("lon", "longitude"))
                              if name in dataset.dims})
    longitude = dataset["longitude"].values
    dataset = dataset.assign_coords(longitude=np.where(longitude >= 180, longitude - 360, longitude))
    dataset = dataset.sortby(["latitude", "longitude"])
    latitude, longitude = grid_axis(grid["latitude"]), grid_axis(grid["longitude"])
    same = (dataset.sizes["latitude"] == latitude.size and dataset.sizes["longitude"] == longitude.size
            and np.allclose(dataset["latitude"], latitude, atol=1e-3)
            and np.allclose(dataset["longitude"], longitude, atol=1e-3))
    if same:
        return dataset.assign_coords(latitude=latitude, longitude=longitude), False
    # Wrap one column on each side so longitudes near ±180 interpolate across the antimeridian.
    wrapped = xr.concat([
        dataset.isel(longitude=[-1]).assign_coords(longitude=dataset["longitude"][[-1]] - 360),
        dataset,
        dataset.isel(longitude=[0]).assign_coords(longitude=dataset["longitude"][[0]] + 360),
    ], dim="longitude")
    return wrapped.interp(latitude=latitude, longitude=longitude, kwargs={"fill_value": None}), True


def read_day(config: dict[str, Any], paths: list[Path], day: date) -> xr.Dataset:
    """One day of the configured variables as (time, latitude, longitude) in store units."""
    parts = []
    for path in paths:
        with xr.open_dataset(path, engine="netcdf4") as source:
            parts.append(as_valid_time(source).load())
    merged = xr.merge(parts, compat="override", join="outer")
    shift = np.timedelta64(int(config.get("timeShiftHours", 0)), "h")
    merged = merged.assign_coords(time=merged["time"].values + shift)
    stamp = merged["time"].values.astype("datetime64[D]")
    merged = merged.isel(time=np.flatnonzero(stamp == np.datetime64(day.isoformat()))).sortby("time")
    variables = {}
    for name, spec in config["variables"].items():
        if spec["source"] not in merged:
            available = sorted(str(key) for key in merged.data_vars)
            raise KeyError(f"{spec['source']} ({spec['request']}) is not in the ADS file; it holds {available}")
        variable = (merged[spec["source"]].astype(np.float32) * np.float32(spec.get("factor", 1))
                    + np.float32(spec.get("offset", 0)))
        if spec.get("zeroAsFill"):
            variable = variable.where(variable != 0)
        # Replace, not extend: arithmetic keeps the provider's GRIB_* attributes.
        variable.attrs = {"long_name": spec["longName"], "units": spec["units"]}
        variables[name] = variable
    dataset = xr.Dataset(variables).transpose("time", ...)
    dataset = dataset.drop_vars([name for name in dataset.coords if name not in ("time", "latitude", "longitude")])
    dataset, interpolated = on_grid(dataset, config["grid"])
    dataset["latitude"].attrs = {"standard_name": "latitude", "units": "degrees_north"}
    dataset["longitude"].attrs = {"standard_name": "longitude", "units": "degrees_east"}
    dataset.attrs = {
        "title": config["product"],
        "institution": "European Centre for Medium-Range Weather Forecasts (ECMWF)",
        "source": f"Copernicus Atmosphere Data Store, dataset {config['dataset']}",
        "references": f"https://ads.atmosphere.copernicus.eu/datasets/{config['dataset']}",
        "license": LICENSE.format(year=day.year),
        "ads_request": json.dumps({key: value for key, value in config["request"].items()}),
        "history": "Converted from ADS netCDF by zartigl scripts/to_zarr/cams"
                   + ("; interpolated onto the store grid" if interpolated else ""),
    }
    return dataset


def encodings(config: dict[str, Any], dataset: xr.Dataset) -> dict[str, dict[str, Any]]:
    from numcodecs import Blosc

    compressor = Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE)
    result: dict[str, dict[str, Any]] = {"time": {"units": TIME_UNITS, "calendar": "standard", "dtype": "int32"}}
    for name in dataset.data_vars:
        spec = config["variables"][name]
        if spec.get("dtype") == "float32":
            result[name] = {"dtype": "float32", "_FillValue": np.float32(np.nan), "compressors": (compressor,)}
        else:
            result[name] = {"dtype": "int16", "_FillValue": FILL_INT16, "scale_factor": float(spec["scaleFactor"]),
                            "compressors": (compressor,)}
    return result


def clip_to_int16(config: dict[str, Any], dataset: xr.Dataset) -> xr.Dataset:
    """Values outside what int16 holds at the variable's scale would wrap around; clip them instead."""
    for name, variable in dataset.data_vars.items():
        spec = config["variables"][name]
        if spec.get("dtype") != "float32":
            limit = np.float32(32767 * spec["scaleFactor"])
            dataset[name] = variable.clip(-limit, limit)
    return dataset


def product(config: dict[str, Any], label: str, fetch: Any = None) -> Product:
    return Product(
        label,
        fetch_day=fetch or Fetcher(),
        read_day=lambda paths, day: read_day(config, paths, day),
        to_store=lambda dataset: (clip_to_int16(config, dataset), encodings(config, dataset)),
    )


def main(doc: str, config_path: Path, label: str) -> None:
    common.main(doc, config_path, lambda config: product(config, label))
