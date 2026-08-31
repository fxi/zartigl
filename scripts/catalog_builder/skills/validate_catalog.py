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

    if catalog.get("schemaVersion") != 2:
        fail("catalog schemaVersion must be 2")
    default_locale = catalog.get("defaultLocale")

    # Entry and source identities are stable, catalog-wide UUIDs.
    ids = [layer["id"] for layer in layers]
    dupes = [i for i in ids if ids.count(i) > 1]
    if dupes:
        fail(f"Duplicate layer ids: {set(dupes)}")

    source_ids = [source["id"] for layer in layers for source in layer["sources"]]
    duplicate_source_ids = {item for item in source_ids if source_ids.count(item) > 1}
    if duplicate_source_ids:
        fail(f"Duplicate source ids: {duplicate_source_ids}")
    identity_overlap = set(ids) & set(source_ids)
    if identity_overlap:
        fail(f"UUIDs cannot identify both entries and sources: {identity_overlap}")

    aliases = [alias for layer in layers for alias in layer.get("aliases", [])]
    duplicate_aliases = {alias for alias in aliases if aliases.count(alias) > 1}
    if duplicate_aliases:
        fail(f"Duplicate search aliases: {duplicate_aliases}")

    data_keys = []
    for layer in layers:
        if default_locale not in layer["title"]:
            fail(f"{layer['id']}: title.{default_locale} is required")
        if layer.get("description") and default_locale not in layer["description"]:
            fail(f"{layer['id']}: description.{default_locale} is required")

        sources = layer["sources"]
        source_by_id = {source["id"]: source for source in sources}
        defaults = layer["defaults"]
        if defaults["sourceId"] not in source_by_id:
            fail(f"{layer['id']}: defaults.sourceId does not belong to the entry")
        query_id = defaults.get("querySourceId")
        if query_id:
            query_source = source_by_id.get(query_id)
            if not query_source or query_source["type"] != "zarr" or not query_source["endpoints"].get("pointSeries"):
                fail(f"{layer['id']}: defaults.querySourceId must reference a point-series Zarr source")

        for source in sources:
            if default_locale not in source["title"]:
                fail(f"{layer['id']}/{source['id']}: title.{default_locale} is required")
            if layer["kind"] == "vector" and source["type"] != "zarr":
                fail(f"{layer['id']}: vector entries only support Zarr render sources")
            if source["type"] != "zarr":
                continue
            variables = source["variables"]
            if layer["kind"] != variables["kind"]:
                fail(f"{layer['id']}: layer kind and Zarr variables.kind differ")
            identifiers = (source.get("provenance") or {}).get("identifiers") or {}
            dataset_id = identifiers.get("dataset", source["endpoints"]["field"])
            if layer["kind"] == "vector":
                derivation = variables.get("derivation")
                variable_key = (derivation.get("kind"), derivation.get("direction_variable"), derivation.get("magnitude_variable"), derivation.get("direction_convention"), derivation.get("output_direction")) if derivation else (variables.get("u"), variables.get("v"))
            else:
                variable_key = (variables.get("value"),)
            data_keys.append((source.get("provenance", {}).get("provider"), dataset_id, *variable_key))

        palette = defaults.get("palette")
        if palette and palette not in palettes:
            fail(f"{layer['id']}: unknown default palette {palette!r}")

        color_domain = (defaults.get("raster") or {}).get("colorDomain")
        if color_domain is not None:
            if layer["kind"] != "scalar":
                fail(f"{layer['id']}: raster.colorDomain is only valid on scalar layers")
            if color_domain[0] >= color_domain[1]:
                fail(f"{layer['id']}: raster.colorDomain minimum must be less than maximum")

    dupe_data = [k for k in data_keys if data_keys.count(k) > 1]
    if dupe_data:
        fail(f"Duplicate data layers: {set(dupe_data)}")

    print(f"✓ catalog.json is valid ({len(layers)} layer(s))")


if __name__ == "__main__":
    main()
