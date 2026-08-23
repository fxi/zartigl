#!/usr/bin/env python3
"""Build small, provenance-rich JSON extracts used by the story demo."""

from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import urlopen

import numpy as np
import xarray as xr
from fsspec.implementations.http import HTTPFileSystem

ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = ROOT / "src/catalog/catalog.json"
OUTPUT_DIR = ROOT / "src/demo-story/data"
ENSO_REGIONS = [
    {"id": "nino-12", "label": "Niño 1+2", "bounds": {"west": -90, "south": -10, "east": -80, "north": 0}},
    {"id": "nino-3", "label": "Niño 3", "bounds": {"west": -150, "south": -5, "east": -90, "north": 5}},
    {"id": "nino-34", "label": "Niño 3.4", "bounds": {"west": -170, "south": -5, "east": -120, "north": 5}},
    {"id": "nino-4", "label": "Niño 4", "bounds": {"west": 160, "south": -5, "east": -150, "north": 5}},
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def iso_time(value: Any) -> str:
    return np.datetime_as_string(np.datetime64(value, "ms"), unit="ms") + "Z"


def finite_or_none(value: Any) -> float | None:
    number = float(value)
    return round(number, 5) if math.isfinite(number) else None


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class PublicArcoHttpFileSystem(HTTPFileSystem):
    """Treat CloudFerro's 403 for absent sparse chunks as a normal missing key."""

    def _raise_not_found_for_status(self, response: Any, url: str) -> None:
        if response.status in (403, 404):
            raise FileNotFoundError(url)
        super()._raise_not_found_for_status(response, url)


def open_http_zarr(url: str) -> xr.Dataset:
    mapper = PublicArcoHttpFileSystem().get_mapper(url)
    return xr.open_zarr(mapper, consolidated=True, chunks="auto", zarr_format=2)


def catalog_layer(layer_id: str) -> dict[str, Any]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return next(layer for layer in catalog["layers"] if layer["id"] == layer_id)


def manifest_range(url: str) -> tuple[str, str]:
    with urlopen(url, timeout=30) as response:
        manifest = json.load(response)
    timeline = manifest["timeline"]
    if timeline["kind"] == "range":
        return timeline["dateStart"], timeline["dateEnd"]
    values = timeline["values"]
    return values[0], values[-1]


def coordinate_slice(values: xr.DataArray, low: float, high: float) -> slice:
    return slice(high, low) if float(values[0]) > float(values[-1]) else slice(low, high)


def region_subset(data: xr.DataArray, bounds: dict[str, float]) -> xr.DataArray:
    selected = data.sel(latitude=coordinate_slice(data.latitude, bounds["south"], bounds["north"]))
    west, east = bounds["west"], bounds["east"]
    longitude = selected.longitude
    if float(longitude.min()) >= 0:
        west = west % 360
        east = east % 360
    if east >= west:
        return selected.sel(longitude=coordinate_slice(longitude, west, east))
    first = selected.sel(longitude=coordinate_slice(longitude, west, float(longitude.max())))
    second = selected.sel(longitude=coordinate_slice(longitude, float(longitude.min()), east))
    return xr.concat([first, second], dim="longitude")


def region_statistics(data: xr.DataArray) -> xr.Dataset:
    weights = xr.DataArray(
        np.cos(np.deg2rad(data.latitude.values)),
        coords={"latitude": data.latitude},
        dims=("latitude",),
    )
    dimensions = ("latitude", "longitude")
    return xr.Dataset({
        "mean": data.weighted(weights).mean(dim=dimensions, skipna=True),
        "min": data.min(dim=dimensions, skipna=True),
        "max": data.max(dim=dimensions, skipna=True),
        "count": data.count(dim=dimensions),
    })


def build_enso() -> None:
    layer = catalog_layer("sea-surface-temperature-anomaly")
    store_url = layer["stores"]["pointSeries"]["url"]
    variable = layer["variables"]["value"]
    manifest_url = layer["derived"]["geoVideos"][0]["manifestUrl"]
    start, end = manifest_range(manifest_url)
    dataset = open_http_zarr(store_url)
    data = dataset[variable].sel(time=slice(np.datetime64(start.removesuffix("Z")), np.datetime64(end.removesuffix("Z"))))
    regions: list[dict[str, Any]] = []

    for region in ENSO_REGIONS:
        stats = region_statistics(region_subset(data, region["bounds"])).compute()
        points = []
        for index, time in enumerate(stats.time.values):
            points.append({
                "time": iso_time(time),
                "mean": finite_or_none(stats["mean"].values[index]),
                "min": finite_or_none(stats["min"].values[index]),
                "max": finite_or_none(stats["max"].values[index]),
                "count": int(stats["count"].values[index]),
            })
        regions.append({**region, "points": points})

    result = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "source": {
            "layerId": layer["id"],
            "datasetId": layer["dataset"]["id"],
            "storeUrl": store_url,
            "variable": variable,
            "unit": "°C",
            "method": "Exact native-grid area-weighted mean using cos(latitude); missing cells excluded.",
            "timeStart": start,
            "timeEnd": end,
        },
        "regions": regions,
    }
    write_json(OUTPUT_DIR / "enso.json", result)


def main() -> None:
    build_enso()


if __name__ == "__main__":
    main()
