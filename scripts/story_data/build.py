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
HYPOXIA_THRESHOLD_MMOL_M3 = 62.5
EARTH_RADIUS_KM = 6371.0088


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


def spherical_cell_areas(latitude: np.ndarray, longitude: np.ndarray) -> np.ndarray:
    """Return rectilinear lon/lat grid-cell areas in square kilometres."""
    lat = np.deg2rad(np.asarray(latitude, dtype=np.float64))
    lon = np.unwrap(np.deg2rad(np.asarray(longitude, dtype=np.float64)))
    if len(lat) < 2 or len(lon) < 2:
        raise ValueError("Area calculation requires at least two latitude and longitude values")
    lat_edges = np.concatenate((
        [lat[0] - (lat[1] - lat[0]) / 2],
        (lat[:-1] + lat[1:]) / 2,
        [lat[-1] + (lat[-1] - lat[-2]) / 2],
    ))
    lon_edges = np.concatenate((
        [lon[0] - (lon[1] - lon[0]) / 2],
        (lon[:-1] + lon[1:]) / 2,
        [lon[-1] + (lon[-1] - lon[-2]) / 2],
    ))
    lat_factor = np.abs(np.sin(lat_edges[1:]) - np.sin(lat_edges[:-1]))[:, None]
    lon_width = np.abs(np.diff(lon_edges))[None, :]
    return EARTH_RADIUS_KM**2 * lat_factor * lon_width


def hypoxia_area_statistics(data: xr.DataArray, threshold: float) -> xr.Dataset:
    areas = xr.DataArray(
        spherical_cell_areas(data.latitude.values, data.longitude.values),
        coords={"latitude": data.latitude, "longitude": data.longitude},
        dims=("latitude", "longitude"),
    )
    valid = data.notnull()
    dimensions = ("latitude", "longitude")
    valid_area = areas.where(valid).sum(dim=dimensions)
    hypoxic_area = areas.where(valid & (data < threshold)).sum(dim=dimensions)
    return xr.Dataset({
        "hypoxic_area_km2": hypoxic_area,
        "valid_area_km2": valid_area,
        "hypoxic_fraction_pct": 100 * hypoxic_area / valid_area,
    })


def require_complete_month_axis(values: np.ndarray, start: np.datetime64, end: np.datetime64) -> None:
    months = np.asarray(values).astype("datetime64[M]")
    expected = np.arange(start.astype("datetime64[M]"), end.astype("datetime64[M]") + 1)
    if not np.array_equal(months, expected):
        raise RuntimeError(f"Expected one sample for every month from {start} to {end}; found {months}")


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


def trailing_mean(values: list[float], window: int) -> list[float | None]:
    return [
        round(sum(values[max(0, index - window + 1):index + 1]) / min(window, index + 1), 3)
        if index + 1 >= window else None
        for index in range(len(values))
    ]


def build_baltic_hypoxia() -> None:
    layer = catalog_layer("baltic-bottom-oxygen")
    store_url = layer["stores"]["field"]["url"]
    variable = layer["variables"]["value"]
    dataset = open_http_zarr(store_url)
    data = dataset[variable]
    start = np.datetime64("1993-09-01")
    end = np.datetime64("2025-09-01")
    selected = data.sel(time=slice(start, end))
    require_complete_month_axis(selected.time.values, start, end)
    stats = hypoxia_area_statistics(selected, HYPOXIA_THRESHOLD_MMOL_M3).compute()
    areas = [float(value) for value in stats["hypoxic_area_km2"].values]
    september_indices = [
        index for index, time_value in enumerate(selected.time.values)
        if int(time_value.astype("datetime64[M]").astype(int) % 12) + 1 == 9
    ]
    september_means = trailing_mean([areas[index] for index in september_indices], 5)
    trailing_by_index = dict(zip(september_indices, september_means, strict=True))
    points = []
    for index, time_value in enumerate(selected.time.values):
        points.append({
            "time": iso_time(time_value),
            "hypoxicAreaKm2": round(areas[index], 3),
            "validAreaKm2": round(float(stats["valid_area_km2"].values[index]), 3),
            "hypoxicFractionPct": round(float(stats["hypoxic_fraction_pct"].values[index]), 3),
            "trailingFiveYearMeanKm2": trailing_by_index.get(index),
        })
    result = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "source": {
            "layerId": layer["id"],
            "datasetId": layer["dataset"]["id"],
            "productId": layer["dataset"]["productId"],
            "storeUrl": store_url,
            "variable": variable,
            "unit": "mmol m-3",
            "timeStart": points[0]["time"],
            "timeEnd": points[-1]["time"],
        },
        "analysis": {
            "label": "Modelled seafloor area below the operational hypoxia threshold",
            "sampling": "Every monthly mean from September 1993 through September 2025; plotted comparison uses September only.",
            "thresholdMmolM3": HYPOXIA_THRESHOLD_MMOL_M3,
            "thresholdMgL": 2,
            "comparison": "strictly less than",
            "areaMethod": "Exact spherical area of each native rectilinear lon/lat cell; missing cells excluded.",
            "rollingMean": "Trailing five-year arithmetic mean of September values only; omitted until five complete Septembers are available.",
            "limitations": [
                "This is a model reanalysis, not an in-situ observation.",
                "Copernicus reports a positive dissolved-oxygen bias in deep basins, where anoxia is not reproduced everywhere.",
                "The animation shows variability and evolution; it does not attribute individual years to a single driver.",
            ],
        },
        "references": [
            {
                "label": "Copernicus Marine product",
                "url": "https://data.marine.copernicus.eu/product/BALTICSEA_MULTIYEAR_BGC_003_012/description",
            },
            {
                "label": "Copernicus quality information",
                "url": "https://documentation.marine.copernicus.eu/QUID/CMEMS-BAL-QUID-003-012.pdf",
            },
            {
                "label": "HELCOM shallow-water oxygen",
                "url": "https://indicators.helcom.fi/indicator/shallow-water-oxygen/",
            },
            {
                "label": "HELCOM eutrophication",
                "url": "https://stateofthebalticsea.helcom.fi/findings/pressures/pollution/eutrophication/",
            },
        ],
        "points": points,
    }
    write_json(OUTPUT_DIR / "baltic-hypoxia.json", result)


def main() -> None:
    build_enso()
    build_baltic_hypoxia()


if __name__ == "__main__":
    main()
