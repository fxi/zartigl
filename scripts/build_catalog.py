#!/usr/bin/env python3
"""
Generate catalog.json from the Copernicus Marine STAC catalog.

Reads dataset IDs from base_catalog.yaml, auto-detects type (vector/scalar)
and variables from the Copernicus Marine API, and writes a catalog file with
ARCO Zarr S3 URLs, chunk layouts, and available time/depth ranges for
browser-side consumption.

Usage:
    cd scripts/
    uv run build_catalog.py

Output: ../public/data/catalog.json
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import copernicusmarine
import yaml

OUTPUT = Path(__file__).resolve().parent.parent / "public" / "data" / "catalog.json"
BASE_CONFIG = Path(__file__).resolve().parent / "base_catalog.yaml"

VISUAL_DEFAULTS_VECTOR = {
    "palette": "rdylbu",
    "renderMode": "particles",
    "particleDensity": 0.05,
    "speedMin": 0.01,
    "speedMax": 1.0,
    "fadeMin": 0.9,
    "fadeMax": 0.96,
    "dropRate": 0.003,
    "dropRateBump": 0.01,
    "opacity": 1.0,
    "logScale": False,
    "vibrance": 0.0,
}

VISUAL_DEFAULTS_SCALAR = {
    "palette": "rdylbu",
    "renderMode": "raster",
    "opacity": 1.0,
    "logScale": False,
    "vibrance": 0.0,
}


def load_base_config(path: Path) -> list[dict]:
    with open(path) as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict) or "datasets" not in data:
        raise ValueError(
            f"{path}: expected a mapping with a 'datasets' key, got: {type(data).__name__}"
        )
    datasets = data["datasets"]
    if not isinstance(datasets, list):
        raise ValueError(
            f"{path}: 'datasets' must be a list, got: {type(datasets).__name__}"
        )
    for i, item in enumerate(datasets):
        if not isinstance(item, dict) or "id" not in item:
            raise ValueError(
                f"{path}: datasets[{i}] must be a mapping with an 'id' key"
            )
    return datasets


def select_service(part):
    """Prefer arco-geo-series zarr; fall back to any zarr service."""
    zarr_services = [s for s in part.services if s.service_format == "zarr"]
    for s in zarr_services:
        if s.service_name == "arco-geo-series":
            return s
    return zarr_services[0] if zarr_services else None


def detect_type_and_variables(svc) -> tuple[str, list[str]]:
    """
    Detect whether this dataset is a vector or scalar field.

    Vector: at least one variable with 'eastward' in standard_name
            and at least one with 'northward' in standard_name.
            When multiple candidates exist, prefer the shortest standard_name
            (fewest qualifiers — e.g. 'eastward_wind' over 'eastward_wind_bias').
    Scalar: everything else.

    Returns ("vector", [u_name, v_name]) or ("scalar", [all_var_names]).
    """
    u_candidates = []
    v_candidates = []
    all_names = []

    for v in svc.variables:
        all_names.append(v.short_name)
        sn = (v.standard_name or "").lower()
        if "eastward" in sn:
            u_candidates.append((v.short_name, sn))
        elif "northward" in sn:
            v_candidates.append((v.short_name, sn))

    if u_candidates and v_candidates:
        u_name = min(u_candidates, key=lambda x: len(x[1]))[0]
        v_name = min(v_candidates, key=lambda x: len(x[1]))[0]
        return "vector", [u_name, v_name]

    return "scalar", all_names


def detect_vertical_label(dimensions: dict) -> str | None:
    for dim in dimensions.values():
        if dim.get("axis") != "z":
            continue
        units = dim.get("units", "")
        if units == "m":
            return "depth"
        if any(p in units.lower() for p in ("pa", "bar", "dbar")):
            return "pressure"
        return "depth"
    return None


def extract_api_label(prod, ds) -> str | None:
    for attr in ("title", "short_description"):
        val = getattr(prod, attr, None)
        if val and isinstance(val, str):
            return val
    for attr in ("title", "short_description"):
        val = getattr(ds, attr, None)
        if val and isinstance(val, str):
            return val
    return None


def build_dimensions(ref_var) -> dict:
    dimensions = {}
    for coord in ref_var.coordinates:
        dim: dict = {"axis": coord.axis}

        if coord.values is not None:
            dim["values"] = coord.values
            dim["size"] = len(coord.values)
        else:
            dim["size"] = (
                int((coord.maximum_value - coord.minimum_value) / coord.step) + 1
                if coord.step
                else None
            )
            if coord.minimum_value is not None:
                dim["min"] = coord.minimum_value
            if coord.maximum_value is not None:
                dim["max"] = coord.maximum_value
            if coord.step is not None:
                dim["step"] = coord.step

        if coord.chunking_length is not None:
            dim["chunk_size"] = coord.chunking_length
        if coord.coordinate_unit:
            dim["units"] = coord.coordinate_unit

        dimensions[coord.coordinate_id] = dim
    return dimensions


def build_entry(entry_cfg: dict) -> dict | None:
    dataset_id = entry_cfg["id"]
    yaml_overrides = {k: v for k, v in entry_cfg.items() if k != "id"}
    forced_u = yaml_overrides.pop("variableU", None)
    forced_v = yaml_overrides.pop("variableV", None)
    print(f"  Querying {dataset_id} ...")

    try:
        cat = copernicusmarine.describe(
            dataset_id=dataset_id,
            disable_progress_bar=True,
        )
    except Exception as e:
        print(f"    ⚠ Network/API error: {e}")
        return None

    if not cat.products:
        print(f"    ⚠ No products found — skipping")
        return None

    prod = cat.products[0]
    ds = prod.datasets[0]
    ver = ds.versions[0]
    part = ver.parts[0]

    svc = select_service(part)
    if svc is None:
        print(f"    ⚠ No ARCO Zarr service found — skipping")
        return None

    if not svc.variables:
        print(f"    ⚠ No variables in service — skipping")
        return None

    print(f"    URL: {svc.uri}")

    if forced_u and forced_v:
        dtype, var_names = "vector", [forced_u, forced_v]
    else:
        dtype, var_names = detect_type_and_variables(svc)
    print(f"    Type: {dtype}, variables: {var_names}")

    variables = {}
    for v in svc.variables:
        if v.short_name in var_names:
            variables[v.short_name] = {
                "standard_name": v.standard_name,
                "units": v.units,
            }

    dimensions = build_dimensions(svc.variables[0])
    vertical_label = detect_vertical_label(dimensions)

    label = yaml_overrides.pop("label", None) or extract_api_label(prod, ds) or dataset_id

    fallback = VISUAL_DEFAULTS_VECTOR if dtype == "vector" else VISUAL_DEFAULTS_SCALAR
    defaults = {**fallback, **yaml_overrides}

    if dtype == "scalar" and "selectedVariable" not in defaults:
        defaults["selectedVariable"] = var_names[0]

    entry: dict = {
        "id": dataset_id,
        "type": dtype,
        "product": prod.product_id,
        "label": label,
        "zarr_url": svc.uri,
        "variables": variables,
        "dimensions": dimensions,
    }
    if vertical_label is not None:
        entry["vertical_label"] = vertical_label
    entry["defaults"] = defaults

    return entry


def main():
    print("Building catalog from Copernicus Marine ...")

    if not BASE_CONFIG.exists():
        print(f"  ⚠ {BASE_CONFIG.name} not found — nothing to build")
        return

    try:
        dataset_configs = load_base_config(BASE_CONFIG)
    except (yaml.YAMLError, ValueError) as e:
        print(f"  ✗ Bad YAML in {BASE_CONFIG.name}: {e}")
        sys.exit(1)

    print(f"  Loaded base config: {len(dataset_configs)} dataset(s)")

    entries = []
    for cfg in dataset_configs:
        entry = build_entry(cfg)
        if entry:
            entries.append(entry)

    catalog = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "datasets": entries,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"\nWrote {OUTPUT} ({len(entries)} dataset(s))")


if __name__ == "__main__":
    main()
