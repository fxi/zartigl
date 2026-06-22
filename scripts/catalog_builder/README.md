# catalog_builder

Agentic toolkit for maintaining `src/catalog/catalog.json`.

## Agentic usage (Claude Code)

To add a new layer/layer, open Claude Code and invoque the prompt. Example to 
add a layer / layer  in the catalog

> Read `scripts/catalog_builder/PROMPT.md` and add a waves layer to the catalog.

Claude Code will:
1. Read PROMPT.md (schema + rules)
2. Run `list_layers.py` to check for duplicates
3. Run `search_products.py` to find candidates
4. Run `query_dataset.py` on the chosen dataset
5. Propose a layer entry for your approval
6. Append it to `catalog.json` and run `validate_catalog.py`

## Catalog schema at a glance

Each layer has:
- `id` — kebab-case slug (e.g. `ocean-current-velocity`)
- `label` / `description` / `category` — display metadata
- `kind` — `vector` or `scalar`
- `dataset` — provenance metadata
- `stores.field` / `stores.pointSeries` / `stores.wmts` — rendering and query stores
- `variables` — scalar value, vector components, or vector derivation
- `defaults` — render mode plus grouped palette, particle, and raster parameters

Time, vertical, spatial, and variable metadata are resolved live from each Zarr store. They are intentionally not duplicated in the catalog.

See `PROMPT.md` Section 1 for the full field reference.
