#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "fsspec[http]>=2025.3",
#   "numpy>=2.0",
#   "xarray>=2025.1",
#   "zarr>=2.18,<3",
# ]
# ///
"""Compute deterministic fallback univariate statistics for a Zarr variable.

Use this only when the provider does not publish visualization statistics.
The fixed 65,536-bin histogram makes percentile calculation bounded-memory and
repeatable; exact extrema and counts are always reported.
"""

from __future__ import annotations

import argparse
import json
import math

import numpy as np
import xarray as xr


PERCENTILES = (1, 2, 5, 50, 95, 98, 99)
HISTOGRAM_BINS = 65_536


def selected_data(args: argparse.Namespace) -> xr.DataArray:
    dataset = xr.open_zarr(args.zarr_url, consolidated=True, chunks=None)
    if args.variable not in dataset:
        raise ValueError(f"Variable not found: {args.variable}")
    data = dataset[args.variable]
    if "time" in data.dims and (args.time_start or args.time_end):
        data = data.sel(time=slice(args.time_start, args.time_end))
    if args.bounds:
        west, south, east, north = args.bounds
        longitude = np.asarray(dataset["longitude"].values)
        latitude = np.asarray(dataset["latitude"].values)
        lon_indices = np.flatnonzero((longitude >= west) & (longitude <= east))
        lat_indices = np.flatnonzero((latitude >= south) & (latitude <= north))
        if not len(lon_indices) or not len(lat_indices):
            raise ValueError("Requested bounds do not intersect the dataset coordinates")
        data = data.isel(longitude=lon_indices, latitude=lat_indices)
    for dimension in list(data.dims):
        if dimension not in {"time", "latitude", "longitude"}:
            data = data.isel({dimension: args.extra_dimension_index})
    return data


def arrays(data: xr.DataArray):
    if "time" not in data.dims:
        yield np.asarray(data.values)
        return
    for index in range(data.sizes["time"]):
        yield np.asarray(data.isel(time=index).values)


def histogram_percentile(histogram: np.ndarray, minimum: float, maximum: float, percentile: int) -> float:
    if minimum == maximum:
        return minimum
    target = math.ceil(int(histogram.sum()) * percentile / 100)
    index = int(np.searchsorted(np.cumsum(histogram), target, side="left"))
    width = (maximum - minimum) / len(histogram)
    return minimum + (index + 0.5) * width


def analyze(data: xr.DataArray) -> dict:
    minimum = math.inf
    maximum = -math.inf
    finite_count = 0
    missing_count = 0
    for values in arrays(data):
        finite = values[np.isfinite(values)]
        finite_count += int(finite.size)
        missing_count += int(values.size - finite.size)
        if finite.size:
            minimum = min(minimum, float(finite.min()))
            maximum = max(maximum, float(finite.max()))
    if finite_count == 0:
        raise ValueError("Selection contains no finite values")

    histogram = np.zeros(HISTOGRAM_BINS, dtype=np.int64)
    for values in arrays(data):
        finite = values[np.isfinite(values)]
        if finite.size:
            histogram += np.histogram(finite, bins=HISTOGRAM_BINS, range=(minimum, maximum))[0]
    percentiles = {
        f"p{percentile:02d}": histogram_percentile(histogram, minimum, maximum, percentile)
        for percentile in PERCENTILES
    }
    attrs = data.attrs
    declared_min = attrs.get("valid_min")
    declared_max = attrs.get("valid_max")
    return {
        "authority": "local-derived-univariate-statistics",
        "method": {"kind": "fixed-histogram", "bins": HISTOGRAM_BINS},
        "variable": data.name,
        "dimensions": list(data.dims),
        "shape": list(data.shape),
        "unit": attrs.get("units"),
        "finiteCount": finite_count,
        "missingCount": missing_count,
        "minimum": minimum,
        "maximum": maximum,
        "percentiles": percentiles,
        "derivedColorDomain": [percentiles["p02"], percentiles["p98"]],
        "zarrValidRangeFallback": (
            [float(declared_min), float(declared_max)]
            if isinstance(declared_min, (int, float)) and isinstance(declared_max, (int, float))
            else None
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zarr_url")
    parser.add_argument("--variable", required=True)
    parser.add_argument("--time-start")
    parser.add_argument("--time-end")
    parser.add_argument("--bounds", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--extra-dimension-index", type=int, default=0)
    args = parser.parse_args()
    print(json.dumps(analyze(selected_data(args)), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
