# Catalog Builder — Developer Contract

The built-in catalog is a public API contract using schema version 2. Entries and sources have committed UUIDv4 identities; aliases and localized text are presentation/search metadata and never resolve through `Zartigl.setLayer()`.

## Entry shape

Each entry contains `id`, search-only `aliases`, localized `title` and optional `description`, a lowercase `category`, scalar/vector `kind`, `sources`, and `defaults.sourceId`. English is required by the catalog's `defaultLocale`.

Sources are discriminated and independently renderable:

- `zarr`: field and optional point-series endpoints plus source-specific variables.
- `wmts`: GetCapabilities URL, native layer identifier, and optional service overrides.
- `geovideo`: a version 3 manifest URL.

Every source has its own UUID and localized title. Put provider-native names under `provenance.provider` and `provenance.identifiers`; Copernicus uses `product` and `dataset`. Put discovery-only cadence and coverage mode under `temporal`. Live source metadata remains authoritative.

For Copernicus scalar entries, the default WMTS JSON legend is the authoritative visualization contract: palette, color domain, scale, clamp behavior, units, and extent. Deterministic locally derived univariate statistics are the fallback when upstream statistics are unavailable. Zarr `valid_min`/`valid_max` are validity bounds and are used only as the final range fallback.

`defaults.querySourceId` may reference only a Zarr source with a point-series endpoint. Vector entries are Zarr-only. WMTS and GeoVideo entries are scalar.

## Source policy

Built-in sources must be public, browser/CORS accessible, and cloud-native. Prefer Copernicus Marine ARCO Zarr discovered with the local workflow. Other Zarr sources must match zartigl's coordinate/chunk contract. WMTS must expose a MapLibre-compatible Web Mercator matrix set. GeoVideo is a visualization transport and does not imply scientific point-query capability.

Do not add GRIB/netCDF/HDF-only products, bespoke APIs, or sources requiring ingestion. Do not use general web search unless broader research is explicitly requested or the ARCO workflow cannot answer a specific question.

## Workflow

```bash
uv run scripts/catalog_builder/skills/list_layers.py
uv run scripts/catalog_builder/skills/search_products.py <keyword> [keyword2 ...]
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id> --variable <scalar_id>
uv run scripts/catalog_builder/skills/analyze_variable.py <zarr_url> --variable <scalar_id>
uv run scripts/catalog_builder/skills/validate_catalog.py
uv run scripts/catalog_builder/skills/validate_remote.py --entry <uuid-or-alias>
```

1. Search the current catalog by aliases/native identifiers to avoid duplicates.
2. Query the selected dataset with an explicit scalar variable; vector pairs remain auto-detected. Use the returned provider visualization defaults.
3. If upstream visualization statistics are unavailable, run the maintained local analyzer rather than an ad hoc program.
4. Generate UUIDv4 values once; never regenerate them during ordinary metadata updates.
5. Ask for approval before appending a built-in entry.
6. Validate the catalog, compare it with live provider metadata, and smoke-test remote rendering/query behavior.

Catalog validation checks structure and cross-references, not remote availability.
