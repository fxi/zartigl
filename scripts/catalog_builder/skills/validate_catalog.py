#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["jsonschema>=4.0"]
# ///
"""
Validate src/catalog/catalog.json against scripts/catalog_builder/schema.json.

Usage:
    uv run scripts/catalog_builder/skills/validate_catalog.py

Exit code 0 on success, 1 on validation failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = SCRIPT_DIR.parent / "schema.json"
CATALOG_PATH = SCRIPT_DIR.parent.parent.parent / "src" / "catalog" / "catalog.json"
PALETTES_PATH = SCRIPT_DIR.parent.parent.parent / "src" / "lib" / "palettes.json"


def fail(message: str):
    print(f"✗ {message}", file=sys.stderr)
    sys.exit(1)


def main():
    if not SCHEMA_PATH.exists():
        fail(f"Schema not found: {SCHEMA_PATH}")

    if not CATALOG_PATH.exists():
        fail(f"Catalog not found: {CATALOG_PATH}")

    schema = json.loads(SCHEMA_PATH.read_text())
    catalog = json.loads(CATALOG_PATH.read_text())

    from jsonschema import validate, ValidationError

    try:
        validate(instance=catalog, schema=schema)
    except ValidationError as e:
        print(f"✗ Validation failed: {e.message}", file=sys.stderr)
        print(f"  Path: {' → '.join(str(p) for p in e.absolute_path)}", file=sys.stderr)
        sys.exit(1)

    layers = catalog.get("layers", [])
    palettes = json.loads(PALETTES_PATH.read_text()) if PALETTES_PATH.exists() else {}

    # Check for duplicate ids
    ids = [layer["id"] for layer in layers]
    dupes = [i for i in ids if ids.count(i) > 1]
    if dupes:
        fail(f"Duplicate layer ids: {set(dupes)}")

    # Check for duplicate data layers. A single Copernicus dataset can expose
    # several catalog layers when they target different variables.
    data_keys = []
    for layer in layers:
        variables = layer["variables"]
        if layer["kind"] != variables["kind"]:
            fail(f"{layer['id']}: layer kind and variables.kind differ")

        if layer["kind"] == "vector":
            derivation = variables.get("derivation")
            if derivation:
                key = (
                    layer["dataset"]["id"],
                    derivation.get("kind"),
                    derivation.get("direction_variable"),
                    derivation.get("magnitude_variable"),
                    derivation.get("direction_convention"),
                    derivation.get("output_direction"),
                )
            else:
                key = (layer["dataset"]["id"], variables.get("u"), variables.get("v"))
            if layer["stores"].get("wmts"):
                fail(f"{layer['id']}: WMTS is only valid on scalar layers")
        else:
            key = (layer["dataset"]["id"], variables.get("value"))

        defaults = layer.get("defaults") or {}
        palette = defaults.get("palette")
        if palette and palette not in palettes:
            fail(f"{layer['id']}: unknown default palette {palette!r}")

        time = layer["dimensions"]["time"]
        if time.get("size", 0) < 1:
            fail(f"{layer['id']}: time dimension size must be >= 1")
        if "min" in time and "max" in time and time["min"] > time["max"]:
            fail(f"{layer['id']}: time dimension min is after max")
        if time.get("size", 1) > 1 and "values" not in time and "step" not in time:
            fail(f"{layer['id']}: time dimension needs values or step when size > 1")

        data_keys.append(key)
    dupe_data = [k for k in data_keys if data_keys.count(k) > 1]
    if dupe_data:
        fail(f"Duplicate data layers: {set(dupe_data)}")

    print(f"✓ catalog.json is valid ({len(layers)} layer(s))")


if __name__ == "__main__":
    main()
