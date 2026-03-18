#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["copernicusmarine>=2.0"]
# ///
"""
Search Copernicus Marine products by keyword and list candidate datasets.

Usage:
    uv run scripts/catalog_builder/skills/search_products.py <keyword> [<keyword2> ...]

Output: JSON array of candidates with dataset IDs, titles, and available services.

Examples:
    uv run scripts/catalog_builder/skills/search_products.py wave swell
    uv run scripts/catalog_builder/skills/search_products.py sea ice
    uv run scripts/catalog_builder/skills/search_products.py chlorophyll
"""

from __future__ import annotations

import json
import sys


def has_zarr(part) -> bool:
    return any(s.service_format == "zarr" for s in part.services)


def main():
    if len(sys.argv) < 2:
        print("Usage: search_products.py <keyword> [<keyword2> ...]", file=sys.stderr)
        sys.exit(1)

    keywords = " ".join(sys.argv[1:])

    import copernicusmarine
    try:
        cat = copernicusmarine.describe(
            contains=[keywords],
            disable_progress_bar=True,
        )
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    candidates = []
    for prod in cat.products:
        for ds in prod.datasets:
            for ver in ds.versions:
                for part in ver.parts:
                    if not has_zarr(part):
                        continue
                    services = [
                        s.service_name
                        for s in part.services
                        if s.service_format == "zarr"
                    ]
                    candidates.append({
                        "dataset_id": ds.dataset_id,
                        "product_id": prod.product_id,
                        "title": getattr(prod, "title", None) or getattr(ds, "title", None) or ds.dataset_id,
                        "zarr_services": services,
                        "variables": [v.short_name for v in part.services[0].variables] if part.services else [],
                    })
                    break  # one part per dataset is enough for discovery

    print(json.dumps(candidates, indent=2))
    print(f"\n# Found {len(candidates)} candidate(s) matching '{keywords}'", file=sys.stderr)


if __name__ == "__main__":
    main()
