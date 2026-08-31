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

    locale = catalog.get("defaultLocale", "en")
    rows = []
    for layer in layers:
        zarr = next((source for source in layer["sources"] if source["type"] == "zarr"), {})
        variables = zarr.get("variables", {})
        derivation = variables.get("derivation", {})
        variable_ids = (
            [variables.get("value")]
            if variables.get("kind") == "scalar"
            else [variables.get("u"), variables.get("v")]
            if variables.get("u") or variables.get("v")
            else [derivation.get("direction_variable"), derivation.get("magnitude_variable")]
        )
        rows.append({
            "id": layer["id"],
            "alias": (layer.get("aliases") or [""])[0],
            "title": layer["title"].get(locale, next(iter(layer["title"].values()))),
            "category": layer["category"], "kind": layer["kind"],
            "dataset": zarr.get("provenance", {}).get("identifiers", {}).get("dataset", ""),
            "variables": ",".join(value for value in variable_ids if value),
        })
    col_id       = max(len(v["id"]) for v in rows)
    col_alias    = max(len(v["alias"]) for v in rows)
    col_label    = max(len(v["title"]) for v in rows)
    col_category = max(len(v.get("category", ""))  for v in layers)
    col_type     = max(len(v.get("kind", ""))       for v in layers)
    col_src      = max(len(v["dataset"]) for v in rows)
    col_vars     = max(len(v["variables"]) for v in rows)

    col_id       = max(col_id, 2)
    col_label    = max(col_label, 5)
    col_alias    = max(col_alias, 5)
    col_category = max(col_category, 8)
    col_type     = max(col_type, 4)
    col_src      = max(col_src, 14)
    col_vars     = max(col_vars, 9)

    sep = f"+{'-'*(col_id+2)}+{'-'*(col_alias+2)}+{'-'*(col_label+2)}+{'-'*(col_category+2)}+{'-'*(col_type+2)}+{'-'*(col_src+2)}+{'-'*(col_vars+2)}+"
    fmt = f"| {{:<{col_id}}} | {{:<{col_alias}}} | {{:<{col_label}}} | {{:<{col_category}}} | {{:<{col_type}}} | {{:<{col_src}}} | {{:<{col_vars}}} |"

    print(sep)
    print(fmt.format("id", "alias", "title", "category", "kind", "dataset", "variables"))
    print(sep)
    for v in rows:
        print(fmt.format(
            v["id"],
            v["alias"], v["title"], v["category"], v["kind"], v["dataset"], v["variables"],
        ))
    print(sep)
    print(f"\n{len(layers)} layer(s)")


if __name__ == "__main__":
    main()
