# Agent Instructions

## Project Structure

- `src/lib/` contains the zartigl runtime: Zarr loading, scalar/vector layers,
  shaders, particle simulation, and the `Zartigl` facade.
- `src/catalog/` contains the built-in catalog JSON and TypeScript exports.
- `src/projversor/` contains the MapLibre-free projversor renderer (blended
  projections, sphere particles and rasters), published as
  `@fxi/zartigl/projversor`.
- `src/story/` contains the story runtime (documents, registry, pager, scene
  timer), published as `@fxi/zartigl/story`.
- `src/demo-prod/` is the full interactive demo app.
- `src/demo-site/` is the home page prototype: a scroll story framed by a
  header and a footer, driven by runtime content (`public/content/`).
- `src/demo-projection/` and `src/demo-story-projversor/` are the projversor
  explorer and story; they import zartigl only through its package entries.
- `src/mapx/` contains MapX snippet generation helpers.
- `scripts/catalog_builder/` contains the catalog maintenance docs, schema, and
  helper scripts.

## Catalog Work

Before adding, changing, or recommending catalog datasets, read
`scripts/catalog_builder/DEVELOPERS.md`.

The built-in catalog is maintained through the local catalog-builder workflow.
Use these scripts first:

```bash
uv run scripts/catalog_builder/skills/list_layers.py
uv run scripts/catalog_builder/skills/search_products.py <keyword> [keyword2 ...]
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id> --variable <scalar_id>
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id> --vector <u>,<v>
uv run scripts/catalog_builder/skills/validate_catalog.py
uv run scripts/catalog_builder/skills/validate_remote.py --entry <uuid-or-alias>
```

For scalar discovery, resolve metadata in this order: Copernicus Toolbox
service/coordinate metadata, the default WMTS JSON legend (palette, range,
scale, unit, extent), deterministic local statistics from
`analyze_variable.py` when upstream statistics are unavailable, and Zarr
`valid_min`/`valid_max` only as a final fallback. Never select the first scalar
variable implicitly.

Do not write one-off analysis programs when maintained scripts can answer the
question. If a deterministic operation is missing, extend an existing helper
or add a tested reusable helper and document it here before continuing.

Do not use general web search for catalog candidates unless the user explicitly
asks for broader dataset research, or the local Copernicus Marine ARCO workflow
cannot answer a specific question. If web research is used, label the result as
source exploration, not as a catalog-ready entry.

Catalog entries must target public, cloud-native Zarr stores compatible with
zartigl's browser-side Zarr ingestion. The preferred source for built-in catalog
entries is Copernicus Marine ARCO discovered through the local scripts.

WMTS is only an optional scalar shortcut. For polar products, prefer Zarr unless
WMTS coverage has been verified to reach the poles; zartigl's shader path is
intended to cover polar views.

Do not propose non-cloud-native services, GRIB/netCDF/HDF-only products, bespoke
APIs, or sources that require ingestion or conversion as catalog-ready entries.


Commits
- single line
- conventional commit 
- no co-author
