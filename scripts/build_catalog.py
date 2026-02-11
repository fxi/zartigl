#!/usr/bin/env python3
"""
Generate catalog.json from the Copernicus Marine STAC catalog.

Queries `copernicusmarine describe` for target datasets and writes
a catalog file with ARCO Zarr S3 URLs, chunk layouts, and available
time/depth ranges for browser-side consumption.

Usage:
    cd scripts/
    uv run build_catalog.py

Output: ../public/data/catalog.json
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import copernicusmarine

OUTPUT = Path(__file__).resolve().parent.parent / "public" / "data" / "catalog.json"

# Datasets to include — add more entries here to grow the catalog.
TARGETS = [
    {
        "dataset_id": "cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i",
        "label": "Global Ocean Currents (analysis+forecast)",
        "variables": ["uo", "vo"],
        # Prefer the timeChunked variant (large spatial chunks, 1 time step)
        "preferred_service": "arco-geo-series",
    },
]


def build_entry(target: dict) -> dict | None:
    dataset_id = target["dataset_id"]
    print(f"  Querying {dataset_id} ...")

    cat = copernicusmarine.describe(
        dataset_id=dataset_id,
        disable_progress_bar=True,
    )

    if not cat.products:
        print(f"    ⚠ No products found")
        return None

    prod = cat.products[0]
    ds = prod.datasets[0]
    ver = ds.versions[0]
    part = ver.parts[0]

    # Find the preferred ARCO service
    svc = None
    for s in part.services:
        if s.service_name == target["preferred_service"]:
            svc = s
            break

    if svc is None or svc.service_format != "zarr":
        print(f"    ⚠ No ARCO Zarr service found")
        return None

    print(f"    URL: {svc.uri}")

    # Build variable info
    variables = {}
    for v in svc.variables:
        if v.short_name in target["variables"]:
            variables[v.short_name] = {
                "standard_name": v.standard_name,
                "units": v.units,
            }

    # Build dimension info from coordinates of first variable
    ref_var = svc.variables[0]
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

    return {
        "id": dataset_id,
        "product": prod.product_id,
        "label": target["label"],
        "zarr_url": svc.uri,
        "variables": variables,
        "dimensions": dimensions,
    }


def main():
    print("Building catalog from Copernicus Marine ...")

    entries = []
    for target in TARGETS:
        entry = build_entry(target)
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
