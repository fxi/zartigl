# Catalog Builder — Agentic Prompt

You are adding or updating layers in `src/catalog/catalog.json` for the zartigl map visualization app. The catalog is a public API contract, not just demo data.

## 1. Layer Schema

Each catalog must have:

```json
{
  "schemaVersion": 1,
  "layers": []
}
```

Each layer must follow this shape:

```json
{
  "id": "kebab-case-slug",
  "label": "Human Readable Name",
  "description": "One sentence describing what this layer shows.",
  "category": "Ocean | Atmosphere | Biology | Waves | Ice",
  "kind": "vector",
  "dataset": {
    "id": "<copernicus_dataset_id>",
    "provider": "copernicus",
    "productId": "<copernicus_product_id>"
  },
  "stores": {
    "field": {
      "url": "https://.../timeChunked.zarr"
    },
    "pointSeries": {
      "url": "https://.../geoChunked.zarr"
    },
    "wmts": { "...": "optional scalar shortcut" }
  },
  "variables": {
    "kind": "vector",
    "u": "uo",
    "v": "vo"
  },
  "defaults": {
    "backend": "zarr",
    "palette": "rdylbu",
    "renderMode": "particles",
    "particles": {
      "density": 0.05,
      "speed": 1.0,
      "fade": 0.7
    },
    "raster": {
      "opacity": 1,
      "logScale": false,
      "vibrance": 0
    }
  }
}
```

For scalar layers, use:

```json
"kind": "scalar",
"variables": {
  "kind": "scalar",
  "value": "<short_name>"
}
```

For direction/magnitude vector derivation, use:

```json
"variables": {
  "kind": "vector",
  "derivation": {
    "kind": "direction_magnitude",
    "direction_variable": "VMDR_SW1",
    "magnitude_variable": "VHM0_SW1",
    "direction_convention": "from",
    "output_direction": "toward"
  }
}
```

## 2. Rules

- `id` is lowercase kebab-case and unique.
- `kind` and `variables.kind` must match.
- `stores.field` is required and is the map-rendering Zarr store.
- `stores.pointSeries` enables point time-series and depth-profile queries.
- `stores.wmts` is only valid on scalar layers.
- Time, vertical, spatial, and variable metadata must not be copied into the catalog; it is loaded live from Zarr.
- `defaults.backend` can be `zarr` or `wmts`; omit it to let the app auto-detect, or set `"wmts"` explicitly when a scalar layer should prefer WMTS rendering.
- `defaults.palette` must exist in `src/lib/palettes.json`.
- `defaults.renderMode` is optional and only affects vector layers. It accepts
  `particles`, `raster`, or `raster+particles`; the runtime default is `particles`.

## 3. Source Policy

The built-in catalog is maintained for public cloud-native Zarr data. The
preferred and scripted source family is Copernicus Marine ARCO, discovered and
queried with the local `copernicusmarine`-based tools in this directory.

- Use `search_products.py` and `query_dataset.py` before looking elsewhere.
- Do not use general web search for catalog candidates unless the user explicitly
  asks for broader source research, or the ARCO workflow cannot answer a specific
  question. Treat web results as source exploration, not catalog-ready entries.
- `validate_catalog.py` checks the JSON contract only. It does not prove that a
  Zarr store renders correctly at runtime.
- Runtime candidates must expose public Zarr metadata and chunks, including
  compatible time, latitude, longitude, variable, and optional vertical
  coordinates.
- External public Zarr sources are possible only when their source policy and
  runtime compatibility are explicitly documented and smoke-tested.
- Do not add GRIB/netCDF/HDF-only products, bespoke APIs, or services that
  require ingestion/conversion before browser-side Zarr access.
- WMTS is only an optional scalar shortcut. For polar products, prefer Zarr unless
  WMTS coverage has been verified to reach the poles; zartigl's shader path is
  intended to cover polar views.

## 4. Display Defaults

Use these as starting points and tune visually:

| Category | Palette | logScale | Notes |
|---|---|---:|---|
| Ocean | `rdylbu` | false | Particles trace currents |
| Atmosphere | `rdylbu` | true | Wind streaks dominant |
| Biology | `algae` or `balance` | true | Log scale often helps concentration fields |
| Waves | `rdylbu` or `deep` | false | Prefer vector components or derivation |
| Ice | `ice` | false | Scalar raster |

## 5. Skills

Run these from the repo root:

```bash
uv run scripts/catalog_builder/skills/list_layers.py
uv run scripts/catalog_builder/skills/search_products.py <keyword> [keyword2 ...]
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id>
uv run scripts/catalog_builder/skills/validate_catalog.py
```

`query_dataset.py` emits candidate stores and variables in the current schema. Always run `validate_catalog.py` after editing.

## 6. Workflow

1. Run `list_layers.py` and avoid duplicate dataset+variable layers.
2. Run `search_products.py` to find candidate Copernicus datasets.
3. Run `query_dataset.py <dataset_id>` for the chosen dataset.
4. Compose a full layer entry using the schema above.
5. Ask the user to approve the entry before appending it.
6. Run `validate_catalog.py` and fix all failures.

## 7. Editing Existing Layers

For defaults, tune the app, copy settings, translate them into grouped `defaults.particles` and `defaults.raster`, then validate.

Note on particle defaults — both are single numbers (the old `ZoomWeighted`
`[atHighZoom, atLowZoom]` arrays are gone):
- `particles.speed` — max on-screen pixels/frame for the fastest current; gives
  constant *visual* speed across zoom. The internal zoom-compensation curve
  (`SPEED_ZOOM_BIAS`, pivot `WORLD_REF`) lives in the shaders
  (`src/lib/shaders/update.frag.glsl` + `draw.vert.glsl`, kept in sync).
- `particles.fade` — trail length in `[0, 1]` (higher = longer); remapped to the
  raw per-frame fade-opacity in `VectorLayer` (`fadeToOpacity`).

`dropRate` / `dropRateBump` are no longer catalog fields — they are internal
`ParticleSimulation` defaults.

For configuration changes, rerun `query_dataset.py`, update stores or variables, then validate. Runtime metadata comes from `.zmetadata` and coordinate chunks.
