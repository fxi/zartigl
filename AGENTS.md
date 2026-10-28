# Agent Instructions

## Project Structure

- `src/lib/` contains the zartigl runtime: Zarr loading, scalar/vector layers,
  shaders, particle simulation, and the `Zartigl` facade.
- `src/catalog/` contains the built-in catalog JSON and TypeScript exports.
- `src/engine.ts` is `@fxi/zartigl/engine`: the MapLibre-free primitives
  (GeoVideo decoding and archives, palettes, color grade, backdrop, trail
  fade, WebGL helpers, shared GLSL chunks as strings). `engine`, `catalog`
  and `story` never import MapLibre (`npm run build:lib` checks the dist).
- `src/story/` contains the story runtime (documents, registry, pager, scene
  timer), published as `@fxi/zartigl/story`.
- `src/explorer/` is the catalog explorer, the full interactive demo app.
- `src/mapx/` contains MapX snippet generation helpers.
- `scripts/catalog_builder/` contains the catalog maintenance docs, schema, and
  helper scripts.
- `scripts/to_zarr/` converts file-only products (netCDF, ADS downloads) into
  ARCO-shaped Zarr under `zarr/<org>/<product>/<version>/` on the zartigl
  bucket, one directory per `<org>/<product>`, run daily by
  `.github/workflows/to-zarr.yml`. `common.py` holds the shared day driver;
  `cams/ads.py` serves every CAMS product from its `config.json`.

## Projversor

The projversor renderer, its demos (explorer, story, home page) and their
browser tests live in their own repository,
[fxi/projversor](https://github.com/fxi/projversor), next to this one in MapX
(`submodules/projversor`). projversor depends on zartigl
(`file:../zartigl` during development) and uses only the `engine`,
`catalog` and `story` entries. zartigl never imports projversor, and MapX
uses only the MapLibre entry and the catalog. A primitive both renderers
need lives here, exported by `engine`: rebuild with `npm run build:lib`
before testing projversor.

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

File-only products (netCDF/GRIB/HDF) become catalog-ready only through a
maintained `scripts/to_zarr/<org>/<product>/` pipeline that publishes to
the zartigl bucket (see `scripts/to_zarr/README.md`); propose one when
ARCO has no equivalent. NOAA Coral Reef Watch heat stress (`noaa/crw_dhw`) is
the reference implementation for plain files; CAMS products from the
Atmosphere Data Store (`cams/global_forecast`, `cams/gfas`) only need a
`config.json` for `cams/ads.py`. Before writing to the bucket, follow "Adding
a product" in `scripts/to_zarr/README.md`; the store contract
(`scripts/to_zarr/contract.py`) is enforced on every write and checked after
each nightly update. Do not propose non-cloud-native services,
bespoke APIs, or one-off conversions as catalog-ready entries.


Commits
- single line
- conventional commit 
- no co-author
