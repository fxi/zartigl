# Agent Instructions

## Project Structure

- `src/lib/` contains the zartigl runtime: Zarr loading, scalar/vector layers,
  shaders, particle simulation, and the `Zartigl` facade.
- `src/catalog/` contains the built-in catalog JSON and TypeScript exports.
- `src/demo-prod/` is the full interactive demo app.
- `src/demo-minimal/` is the smaller public API demo.
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
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id>
uv run scripts/catalog_builder/skills/validate_catalog.py
```

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
