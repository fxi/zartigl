# catalog_builder

Agentic toolkit for maintaining `src/catalog/catalog.json`.

## Agentic usage

To add a new catalog entry, open an AI coding CLI or agent in this repository
and give it a maintenance request. For example:

> Read `AGENTS.md` and `scripts/catalog_builder/DEVELOPERS.md`, then add a waves entry to the catalog.

The agent should:
1. Read the repository instructions and catalog developer contract
2. Run `list_layers.py` to check for duplicates
3. Run `search_products.py` to find candidates
4. Run `query_dataset.py` on the chosen dataset
5. Propose a layer entry for your approval
6. Append it to `catalog.json` and run `validate_catalog.py`

## Catalog schema at a glance

Each layer has:
- `id` — immutable UUIDv4; former names are search-only aliases
- localized `title` / `description` plus stable `category` and tags
- `kind` — `vector` or `scalar`
- independent UUID-addressed `sources` for Zarr, WMTS, and GeoVideo
- source provenance with native provider/product/dataset identifiers and variables
- `defaults.sourceId`, optional `defaults.querySourceId`, and rendering defaults

Time, vertical, spatial, and variable metadata are resolved live from each Zarr store. They are intentionally not duplicated in the catalog.

See `DEVELOPERS.md` and `schema.json` for the full contract.
