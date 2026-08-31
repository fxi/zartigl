#!/usr/bin/env python3
"""Compare scalar catalog defaults with authoritative Copernicus WMTS legends."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

from copernicus_metadata import discover_wmts_visualization, palette_id


ROOT = Path(__file__).resolve().parents[3]
CATALOG_PATH = ROOT / "src" / "catalog" / "catalog.json"


def derived_capabilities_url(field_url: str) -> str | None:
    match = re.search(r"/arco/([^/]+)/([^/]+)/(?:timeChunked|geoChunked)\.zarr/?$", field_url)
    if not match:
        return None
    product, dataset_tag = match.groups()
    return (
        f"https://wmts.marine.copernicus.eu/teroWmts/{product}/{dataset_tag}"
        "?service=WMTS&request=GetCapabilities"
    )


def validate_entry(entry: dict) -> dict:
    zarr = next((source for source in entry["sources"] if source["type"] == "zarr"), None)
    if entry["kind"] != "scalar" or not zarr:
        return {"entryId": entry["id"], "status": "skipped"}
    variable = zarr["variables"]["value"]
    wmts = next((source for source in entry["sources"] if source["type"] == "wmts"), None)
    capabilities_url = wmts.get("capabilitiesUrl") if wmts else derived_capabilities_url(zarr["endpoints"]["field"])
    if not capabilities_url:
        return {"entryId": entry["id"], "status": "unavailable", "reason": "no WMTS service URL"}
    discovered = discover_wmts_visualization(capabilities_url, variable)
    defaults = entry.get("defaults", {})
    raster = defaults.get("raster") or {}
    expected = {
        "palette": palette_id(discovered.get("style"), discovered.get("palette")),
        "colorDomain": discovered["colorDomain"],
        "logScale": discovered["logScale"],
    }
    actual = {
        "palette": defaults.get("palette"),
        "colorDomain": raster.get("colorDomain"),
        "logScale": bool(raster.get("logScale", False)),
    }
    mismatches = [key for key in expected if actual[key] != expected[key]]
    return {
        "entryId": entry["id"],
        "alias": (entry.get("aliases") or [None])[0],
        "variable": variable,
        "status": "ok" if not mismatches else "mismatch",
        "mismatches": mismatches,
        "actual": actual,
        "expected": expected,
        "authority": discovered["authority"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", action="append", help="Entry UUID or alias; repeatable")
    args = parser.parse_args()
    catalog = json.loads(CATALOG_PATH.read_text())
    selected = catalog["layers"]
    if args.entry:
        wanted = set(args.entry)
        selected = [
            entry for entry in selected
            if entry["id"] in wanted or wanted.intersection(entry.get("aliases") or [])
        ]
        found = {entry["id"] for entry in selected} | {
            alias for entry in selected for alias in entry.get("aliases") or []
        }
        missing = sorted(wanted - found)
        if missing:
            raise SystemExit(f"Unknown catalog entry selector(s): {', '.join(missing)}")
    results = []
    failed = False
    for entry in selected:
        try:
            result = validate_entry(entry)
        except Exception as exc:
            result = {"entryId": entry["id"], "status": "error", "error": str(exc)}
        results.append(result)
        failed |= result["status"] in {"mismatch", "error"}
    print(json.dumps(results, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
