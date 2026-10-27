#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.35",
#   "cdsapi>=0.7.4",
#   "dask[array]>=2025.1",
#   "fsspec>=2025.3",
#   "netcdf4>=1.7",
#   "numcodecs>=0.15",
#   "numpy>=2.0",
#   "requests>=2.32",
#   "s3fs>=2025.3",
#   "scipy>=1.14",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""CAMS global atmospheric composition forecasts → Zarr on the zartigl bucket.

Variables, grid, request and store layout are in config.json; the conversion
itself is shared by every CAMS product (scripts/to_zarr/cams/ads.py).

Usage:
  uv run scripts/to_zarr/cams/global_forecast/convert.py plan [--local DIR]
  uv run scripts/to_zarr/cams/global_forecast/convert.py run [--budget 5h] [--jobs 4] [--max-days N] [--local DIR]
  uv run scripts/to_zarr/cams/global_forecast/convert.py sync-geo [--budget 5h] [--force] [--local DIR]

Needs an ADS key (ADS_KEY or ~/.cdsapirc). Without --local, stores are written
to `prefix` of the bucket configured in .env.demo / .env / the environment.
"""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ads  # noqa: E402

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"

if __name__ == "__main__":
    ads.main(__doc__, CONFIG_PATH, "cams-global-forecast")
