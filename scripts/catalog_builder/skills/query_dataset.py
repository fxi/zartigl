#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["copernicusmarine>=2.0"]
# ///
"""
Query a Copernicus Marine dataset and emit a structured JSON summary.

Usage:
    uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id>

Output: JSON with zarr URLs, variables, dimensions, and suggested layer fields.
"""

from __future__ import annotations

import json
import sys
from urllib.parse import urlparse


def select_geo_service(part):
    """Prefer arco-geo-series zarr (timeChunked, optimal for map display); fall back to any zarr."""
    zarr = [s for s in part.services if s.service_format == "zarr"]
    for s in zarr:
        if s.service_name == "arco-geo-series":
            return s
    return zarr[0] if zarr else None


def select_time_service(part):
    """Return arco-time-series zarr (geoChunked, optimal for point queries), or None."""
    for s in part.services:
        if s.service_name == "arco-time-series" and s.service_format == "zarr":
            return s
    return None


def select_wmts_service(part):
    """Return WMTS service metadata, or None."""
    for s in part.services:
        if s.service_name == "wmts":
            return s
    return None


def wmts_base_url(capabilities_url: str) -> str:
    parsed = urlparse(capabilities_url)
    parts = [p for p in parsed.path.split("/") if p]
    if parts:
        path = "/" + parts[0]
    else:
        path = parsed.path
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def build_wmts_metadata(svc, product_id: str, variable: str | None) -> dict | None:
    if svc is None or variable is None:
        return None
    dataset_tag = svc.uri.split("?")[0].rstrip("/").split("/")[-1]
    return {
        "capabilities_url": svc.uri,
        "base_url": wmts_base_url(svc.uri),
        "layer": f"{product_id}/{dataset_tag}/{variable}",
        "tileMatrixSet": "EPSG:3857",
        "format": "image/png",
    }


def detect_vector_vars(svc) -> tuple[str, str] | None:
    """
    Detect eastward/northward variable pair for vector classification.
    Returns (u_name, v_name) or None if not a vector dataset.
    Prefers shortest standard_name to avoid bias/stress variants.
    """
    u_cands, v_cands = [], []
    for v in svc.variables:
        sn = (v.standard_name or "").lower()
        if "eastward" in sn:
            u_cands.append((v.short_name, sn))
        elif "northward" in sn:
            v_cands.append((v.short_name, sn))
    if u_cands and v_cands:
        u = min(u_cands, key=lambda x: len(x[1]))[0]
        v = min(v_cands, key=lambda x: len(x[1]))[0]
        return u, v
    return None


def build_dimensions(ref_var) -> dict:
    dims = {}
    for coord in ref_var.coordinates:
        d: dict = {}
        if coord.values is not None:
            d["values"] = list(coord.values)
            d["size"] = len(coord.values)
        else:
            if coord.minimum_value is not None:
                d["min"] = coord.minimum_value
            if coord.maximum_value is not None:
                d["max"] = coord.maximum_value
            if coord.step is not None:
                d["step"] = coord.step
                if coord.minimum_value is not None and coord.maximum_value is not None:
                    d["size"] = int((coord.maximum_value - coord.minimum_value) / coord.step) + 1
        if coord.chunking_length is not None:
            d["chunkSize"] = coord.chunking_length
        if coord.coordinate_unit:
            d["units"] = coord.coordinate_unit

        if coord.axis == "t":
            dims["time"] = d
        elif coord.axis == "z":
            dims["vertical"] = d
        elif coord.axis == "y":
            dims["latitude"] = d
        elif coord.axis == "x":
            dims["longitude"] = d
    return dims


def main():
    if len(sys.argv) < 2:
        print("Usage: query_dataset.py <dataset_id>", file=sys.stderr)
        sys.exit(1)

    dataset_id = sys.argv[1]

    import copernicusmarine
    try:
        cat = copernicusmarine.describe(dataset_id=dataset_id, disable_progress_bar=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    if not cat.products:
        print(json.dumps({"error": "no products found"}))
        sys.exit(1)

    prod = cat.products[0]
    ds = prod.datasets[0]
    ver = ds.versions[0]
    part = ver.parts[0]

    svc_geo = select_geo_service(part)
    svc_time = select_time_service(part)
    svc_wmts = select_wmts_service(part)

    if svc_geo is None:
        print(json.dumps({"error": "no ARCO Zarr service found"}))
        sys.exit(1)

    variables = {
        v.short_name: {
            "standard_name": v.standard_name,
            "units": v.units,
        }
        for v in svc_geo.variables
    }

    vec = detect_vector_vars(svc_geo)
    suggested_type = "vector" if vec else "scalar"
    suggested_variable_u = vec[0] if vec else None
    suggested_variable_v = vec[1] if vec else None
    suggested_variable = list(variables.keys())[0] if not vec else None
    wmts = build_wmts_metadata(svc_wmts, prod.product_id, suggested_variable)

    dimensions = build_dimensions(svc_geo.variables[0]) if svc_geo.variables else {}

    # Detect vertical label
    vertical_label = None
    if dimensions.get("vertical"):
        units = dimensions["vertical"].get("units", "")
        vertical_label = "pressure" if any(p in units.lower() for p in ("pa", "bar", "dbar")) else "depth"
        dimensions["vertical"]["label"] = vertical_label

    variables_meta = {}
    if suggested_type == "scalar":
        meta = variables.get(suggested_variable, {})
        variables_meta = {
            "kind": "scalar",
            "value": suggested_variable,
            "standardName": meta.get("standard_name"),
            "units": meta.get("units"),
        }
    elif vec:
        meta = variables.get(suggested_variable_u, {})
        variables_meta = {
            "kind": "vector",
            "u": suggested_variable_u,
            "v": suggested_variable_v,
            "standardName": meta.get("standard_name"),
            "units": meta.get("units"),
        }

    result = {
        "dataset_id": dataset_id,
        "product_id": prod.product_id,
        "title": getattr(prod, "title", None) or getattr(ds, "title", None) or dataset_id,
        "stores": {
            "field": {
                "type": "zarr",
                "url": svc_geo.uri,
                "layout": "time-chunked",
            },
            **({
                "pointSeries": {
                    "type": "zarr",
                    "url": svc_time.uri,
                    "layout": "geo-chunked",
                }
            } if svc_time else {}),
            **({"wmts": wmts} if wmts else {}),
        },
        "all_variables": variables,
        "suggested_kind": suggested_type,
        "suggested_variables": variables_meta,
        "dimensions": dimensions,
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
