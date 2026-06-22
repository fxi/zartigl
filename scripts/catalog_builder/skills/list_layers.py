#!/usr/bin/env python3
"""
Print a summary table of all layers in src/catalog/catalog.json.

Usage:
    uv run scripts/catalog_builder/skills/list_layers.py

No external dependencies — uses stdlib only.
"""

from __future__ import annotations

import json
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parent.parent.parent.parent / "src" / "catalog" / "catalog.json"


def main():
    if not CATALOG_PATH.exists():
        print(f"Catalog not found: {CATALOG_PATH}")
        return

    catalog = json.loads(CATALOG_PATH.read_text())
    layers = catalog.get("layers", [])

    if not layers:
        print("No layers in catalog.")
        return

    col_id       = max(len(v["id"])                for v in layers)
    col_label    = max(len(v.get("label", ""))     for v in layers)
    col_category = max(len(v.get("category", ""))  for v in layers)
    col_type     = max(len(v.get("kind", ""))       for v in layers)
    col_src      = max(len(v.get("dataset", {}).get("id", "")) for v in layers)

    col_id       = max(col_id, 2)
    col_label    = max(col_label, 5)
    col_category = max(col_category, 8)
    col_type     = max(col_type, 4)
    col_src      = max(col_src, 14)

    sep = f"+{'-'*(col_id+2)}+{'-'*(col_label+2)}+{'-'*(col_category+2)}+{'-'*(col_type+2)}+{'-'*(col_src+2)}+"
    fmt = f"| {{:<{col_id}}} | {{:<{col_label}}} | {{:<{col_category}}} | {{:<{col_type}}} | {{:<{col_src}}} |"

    print(sep)
    print(fmt.format("id", "label", "category", "kind", "dataset"))
    print(sep)
    for v in layers:
        print(fmt.format(
            v["id"],
            v.get("label", ""),
            v.get("category", ""),
            v.get("kind", ""),
            v.get("dataset", {}).get("id", ""),
        ))
    print(sep)
    print(f"\n{len(layers)} layer(s)")


if __name__ == "__main__":
    main()
