#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["jsonschema>=4.0"]
# ///
"""
Validate public/data/catalog.json against scripts/catalog_builder/schema.json.

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
CATALOG_PATH = SCRIPT_DIR.parent.parent.parent / "public" / "data" / "catalog.json"


def main():
    if not SCHEMA_PATH.exists():
        print(f"✗ Schema not found: {SCHEMA_PATH}", file=sys.stderr)
        sys.exit(1)

    if not CATALOG_PATH.exists():
        print(f"✗ Catalog not found: {CATALOG_PATH}", file=sys.stderr)
        sys.exit(1)

    schema = json.loads(SCHEMA_PATH.read_text())
    catalog = json.loads(CATALOG_PATH.read_text())

    from jsonschema import validate, ValidationError

    try:
        validate(instance=catalog, schema=schema)
    except ValidationError as e:
        print(f"✗ Validation failed: {e.message}", file=sys.stderr)
        print(f"  Path: {' → '.join(str(p) for p in e.absolute_path)}", file=sys.stderr)
        sys.exit(1)

    views = catalog.get("views", [])

    # Check for duplicate ids
    ids = [v["id"] for v in views]
    dupes = [i for i in ids if ids.count(i) > 1]
    if dupes:
        print(f"✗ Duplicate view ids: {set(dupes)}", file=sys.stderr)
        sys.exit(1)

    # Check for duplicate source_datasets
    sources = [v["source_dataset"] for v in views]
    dupe_sources = [s for s in sources if sources.count(s) > 1]
    if dupe_sources:
        print(f"✗ Duplicate source_datasets: {set(dupe_sources)}", file=sys.stderr)
        sys.exit(1)

    print(f"✓ catalog.json is valid ({len(views)} view(s))")


if __name__ == "__main__":
    main()
