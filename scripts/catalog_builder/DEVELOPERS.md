# Catalog Builder — Developer Contract

The built-in catalog is a public API contract using schema version 2. Entries and sources have committed UUIDv4 identities; aliases and localized text are presentation/search metadata and never resolve through `Zartigl.setLayer()`.

## Entry shape

Each entry contains `id`, search-only `aliases`, localized `title` and optional `description`, a lowercase `category`, scalar/vector `kind`, `sources`, and `defaults.sourceId`. English is required by the catalog's `defaultLocale`.

Sources are discriminated and independently renderable:

- `zarr`: field and optional point-series endpoints plus source-specific variables.
- `wmts`: GetCapabilities URL, native layer identifier, and optional service overrides.
- `geovideo`: a version 3 manifest URL.

Every source has its own UUID and localized title. Put provider-native names under `provenance.provider` and `provenance.identifiers`; Copernicus uses `product` and `dataset`. Put discovery-only cadence and coverage mode under `temporal`. Live source metadata remains authoritative.

`defaults.querySourceId` may reference only a Zarr source with a point-series endpoint. Vector entries are Zarr-only. WMTS and GeoVideo entries are scalar.

## Source policy

Built-in sources must be public, browser/CORS accessible, and cloud-native. Prefer Copernicus Marine ARCO Zarr discovered with the local workflow. Other Zarr sources must match zartigl's coordinate/chunk contract. WMTS must expose a MapLibre-compatible Web Mercator matrix set. GeoVideo is a visualization transport and does not imply scientific point-query capability.

Do not add GRIB/netCDF/HDF-only products, bespoke APIs, or sources requiring ingestion. Do not use general web search unless broader research is explicitly requested or the ARCO workflow cannot answer a specific question.

## Workflow

```bash
uv run scripts/catalog_builder/skills/list_layers.py
uv run scripts/catalog_builder/skills/search_products.py <keyword> [keyword2 ...]
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id>
uv run scripts/catalog_builder/skills/validate_catalog.py
```

1. Search the current catalog by aliases/native identifiers to avoid duplicates.
2. Query the selected dataset and compose a complete v2 entry/source.
3. Generate UUIDv4 values once; never regenerate them during ordinary metadata updates.
4. Ask for approval before appending a built-in entry.
5. Validate the catalog and smoke-test remote rendering/query behavior.

Catalog validation checks structure and cross-references, not remote availability.
