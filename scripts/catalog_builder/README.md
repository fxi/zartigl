# catalog_builder

Agentic toolkit for maintaining `public/data/catalog.json`.

## Structure

```
catalog_builder/
  PROMPT.md            ← Full schema reference + agentic workflow rules (start here)
  schema.json          ← JSON Schema for catalog validation
  README.md            ← This file
  skills/
    list_views.py      ← Print summary of current views
    search_products.py ← Search Copernicus Marine by keyword
    query_dataset.py   ← Describe one dataset, emit structured JSON
    validate_catalog.py← Validate catalog.json against schema.json
```

## Quick start

```bash
# See what's already in the catalog
uv run scripts/catalog_builder/skills/list_views.py

# Validate the current catalog
uv run scripts/catalog_builder/skills/validate_catalog.py

# Find datasets for a topic
uv run scripts/catalog_builder/skills/search_products.py wave swell

# Inspect a specific dataset
uv run scripts/catalog_builder/skills/query_dataset.py cmems_mod_glo_wav_anfc_0.083deg_PT3H-i
```

## Agentic usage (Claude Code)

To add a new view, open Claude Code and say:

> Read `scripts/catalog_builder/PROMPT.md` and add a waves view to the catalog.

Claude Code will:
1. Read PROMPT.md (schema + rules)
2. Run `list_views.py` to check for duplicates
3. Run `search_products.py` to find candidates
4. Run `query_dataset.py` on the chosen dataset
5. Propose a view entry for your approval
6. Append it to `catalog.json` and run `validate_catalog.py`

## Catalog schema at a glance

Each view has:
- `id` — kebab-case slug (e.g. `ocean-current-velocity`)
- `label` / `description` / `category` — display metadata
- `type` — `vector` or `scalar`
- `source_dataset` — provenance (Copernicus dataset ID)
- `zarr_url_geo` / `zarr_url_time` — ARCO Zarr S3 URLs
- `variable` (scalar) or `variable_u` + `variable_v` (vector)
- `variable_meta` — `standard_name` + `units`
- `dimensions` — time, lat, lon, depth (if applicable)
- `defaults` — palette, renderMode, particle/raster parameters

See `PROMPT.md` Section 1 for the full field reference.
