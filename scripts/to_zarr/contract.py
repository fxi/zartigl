#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "aiohttp>=3.9",
#   "dask[array]>=2025.1",
#   "fsspec>=2025.3",
#   "numcodecs>=0.15",
#   "numpy>=2.0",
#   "requests>=2.32",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""The store contract every to_zarr product meets, checked before each write and on published stores.

`common.write` refuses a dataset that breaks it, so a new product cannot
publish provider leftovers (GRIB_* attributes, foreign standard names), a
flipped grid or a time axis the browser cannot decode. Run as a script, it
checks published stores from their consolidated metadata, without reading data:

  uv run scripts/to_zarr/contract.py               # every product under scripts/to_zarr
  uv run scripts/to_zarr/contract.py cams/gfas     # a product directory
  uv run scripts/to_zarr/contract.py zarr/cams/gfas/v1.4.2
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any

import numpy as np
import xarray as xr

DIMS = ("time", "latitude", "longitude")
# What a data variable may describe about itself; xarray keeps the encoding (scale, fill) apart.
VARIABLE_ATTRS = {"long_name", "units", "valid_min", "valid_max", "flag_values", "flag_meanings", "comment"}
REQUIRED_VARIABLE_ATTRS = {"long_name", "units"}
REQUIRED_STORE_ATTRS = {"title", "source", "license", "history"}
DTYPES = {"int16", "int32", "float32", "float64"}


def problems(dataset: xr.Dataset) -> list[str]:
    """Contract breaches of a dataset about to be written, or of an opened store."""
    found = []
    for name, variable in dataset.data_vars.items():
        if variable.dims != DIMS:
            found.append(f"{name}: dimensions {variable.dims}, expected {DIMS}")
        extra = sorted(set(variable.attrs) - VARIABLE_ATTRS)
        if extra:
            found.append(f"{name}: attributes outside the contract {extra}")
        missing = sorted(REQUIRED_VARIABLE_ATTRS - set(variable.attrs))
        if missing:
            found.append(f"{name}: missing attributes {missing}")
    for axis, low, high in (("latitude", -90, 90), ("longitude", -180, 180)):
        if axis not in dataset.coords:
            found.append(f"no {axis} coordinate")
            continue
        values = dataset[axis].values
        if values.size > 1 and not np.all(np.diff(values) > 0):
            found.append(f"{axis} is not strictly ascending")
        if values.min() < low or values.max() > high:
            found.append(f"{axis} outside {low}…{high}")
        if dataset[axis].attrs.get("units") != f"degrees_{'north' if axis == 'latitude' else 'east'}":
            found.append(f"{axis}: units {dataset[axis].attrs.get('units')!r}")
    missing = sorted(REQUIRED_STORE_ATTRS - set(dataset.attrs))
    if missing:
        found.append(f"store attributes missing {missing}")
    leftovers = sorted(key for key in dataset.attrs if key.startswith("GRIB_"))
    if leftovers:
        found.append(f"store attributes from the provider {leftovers}")
    return found


def encoding_problems(encodings: dict[str, dict[str, Any]]) -> list[str]:
    """Contract breaches of the encodings a store is created with (or read back from one)."""
    found = []
    time = encodings.get("time", {})
    if not str(time.get("units", "")).startswith("hours since"):
        found.append(f"time: units {time.get('units')!r}, expected 'hours since …' (the browser decodes through float32)")
    if np.dtype(time.get("dtype", "float64")).kind not in "iu":
        found.append(f"time: dtype {time.get('dtype')}, expected an integer")
    for name, encoding in encodings.items():
        if name != "time" and str(np.dtype(encoding.get("dtype", "float64"))) not in DTYPES:
            found.append(f"{name}: dtype {encoding.get('dtype')}, expected one of {sorted(DTYPES)}")
    return found


def require(dataset: xr.Dataset, encodings: dict[str, dict[str, Any]] | None = None) -> None:
    found = problems(dataset) + (encoding_problems(encodings) if encodings is not None else [])
    if found:
        raise ValueError("Store contract not met:\n  " + "\n  ".join(found))


def check_published(prefix: str, base: str) -> list[str]:
    """Contract breaches of the two published stores under `prefix`, read from metadata only."""
    found = []
    times = []
    for name in ("timeChunked", "geoChunked"):
        url = f"{base}/{prefix}/{name}.zarr"
        try:
            store = xr.open_zarr(url, consolidated=True, zarr_format=2)
            raw = xr.open_zarr(url, consolidated=True, zarr_format=2, decode_times=False)
        except Exception as error:  # noqa: BLE001 - any failure to open is a finding
            found.append(f"{name}: cannot open ({type(error).__name__})")
            continue
        encodings = {key: {**store[key].encoding, "units": raw[key].attrs.get("units")} if key == "time"
                     else store[key].encoding for key in (*store.data_vars, "time")}
        found += [f"{name}: {problem}" for problem in problems(store) + encoding_problems(encodings)]
        if raw["time"].encoding.get("chunks", (raw.sizes["time"],))[0] < raw.sizes["time"]:
            found.append(f"{name}: time coordinate spans more than one chunk")
        times.append(store["time"].values)
    if len(times) == 2 and not np.array_equal(times[1], times[0][:times[1].size]):
        found.append("geoChunked time axis is not a prefix of timeChunked")
    return found


def product_prefixes(root: Path = Path(__file__).resolve().parent) -> list[str]:
    return sorted(json.loads(path.read_text())["prefix"] for path in root.glob("*/*/config.json"))


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from s3_bucket import ROOT, read_dotenv

    env = {**read_dotenv(ROOT / ".env.demo"), **read_dotenv(ROOT / ".env")}
    base = f"{env['S3_ENDPOINT'].rstrip('/')}/{env['S3_BUCKET']}"
    failed = False
    here = Path(__file__).resolve().parent
    for target in sys.argv[1:] or product_prefixes():
        config = here / target / "config.json"
        prefix = json.loads(config.read_text())["prefix"] if config.exists() else target
        found = check_published(prefix.strip("/"), base)
        failed |= bool(found)
        print(f"{'FAIL' if found else 'ok  '} {prefix}" + "".join(f"\n       {problem}" for problem in found))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
