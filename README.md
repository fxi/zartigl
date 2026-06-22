# zartigl

A MapLibre GL JS plugin for exploring cloud-hosted Zarr geoscience data directly in the browser.

[![Demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)](https://fxi.github.io/zartigl/)

Zartigl renders scalar rasters and vector particle fields from multidimensional Zarr stores without a dedicated tile server. It is aimed at expert analysis workflows where time, depth or pressure level, point inspection, and reproducible map state matter as much as the visual layer.

## Features

- Browser-side Zarr v2 access with chunk-aware loading and LRU caching
- Scalar raster rendering with palettes, opacity, log scale, and value inspection
- Vector rendering with GPU particle advection and optional raster magnitude display
- Time and vertical-dimension controls for depth, elevation, level, or pressure-like axes
- Point queries for time series and vertical profiles when a point-series store is available
- Catalog-backed datasets with automatic Zarr/WMTS backend selection for scalar layers
- MapLibre custom layer integration, including Mercator and globe rendering paths
- No server component required for public CORS-enabled stores

## Quick Start

```bash
npm install @fxi/zartigl maplibre-gl
```

```ts
import maplibregl from "maplibre-gl";
import { Zartigl } from "@fxi/zartigl";
import { catalog } from "@fxi/zartigl/catalog";

const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [0, 20],
  zoom: 2,
});

const z = new Zartigl({
  id: "zarr-layer",
  map,
  catalog,
  backend: "auto",
});

await z.setLayer("ocean-current-velocity");
z.setTimeAndDepth(new Date("2025-01-01T00:00:00Z"), 0);
z.updateSettings({
  palette: "rdylbu",
  opacity: 0.9,
});
```

`setLayer()` resolves after the field store's consolidated metadata and coordinate axes have loaded. Metadata getters are therefore authoritative after the awaited call, including exact values for irregular time axes.

The root import does not bundle the catalog presets. Import catalog data from `@fxi/zartigl/catalog` only when you want the built-in catalog.

## Demo

The production demo is the default Vite app and is published to GitHub Pages.

```bash
npm install
npm run dev
```

Build the same app that GitHub Pages publishes:

```bash
npm run build:prod
```

For the smaller public API demo:

```bash
npm run dev:minimal
```

The demos read the built-in catalog, which points to public Copernicus Marine ARCO stores. No local data download is needed; visible chunks are fetched directly from cloud object storage or, for some scalar layers, from WMTS when that is the safer backend.

## Public API

The main entry point is the catalog-backed `Zartigl` facade:

```ts
const time = z.getTimeMeta();
const depth = z.getDepthMeta();
const legend = z.getLegend();

z.on("loaded", (meta) => {
  console.log(meta.min, meta.max, meta.unit);
});

const series = await z.queryTimeSeries({
  longitude: 7.4,
  latitude: 46.9,
  depth: 0,
  maxPoints: 256,
});
```

`VectorLayer`, `ScalarLayer`, `ArcoLayer`, and `ZarrSource` remain exported for advanced use cases that need direct control over renderer internals. Ordinary MapLibre integrations should prefer `Zartigl`.

## Why MapLibre Native, Not deck.gl By Default?

deck.gl is a good visualization framework and could become an optional adapter target. It already has useful concepts for layer lifecycle, picking, MapLibre overlay integration, and composition with other deck.gl layers.

Zartigl does not depend on deck.gl today because the project is not only a rendering wrapper. Most of the hard work is renderer-independent:

- reading Zarr metadata and compressed chunks in the browser
- selecting chunks from viewport, time, and vertical coordinates
- decoding scalar and vector variables
- deriving U/V components from direction and magnitude products
- handling nodata, palettes, log scale, and vector magnitude
- protecting users from accidental multi-GB fetches
- querying time series and vertical profiles

A deck.gl implementation would still need nearly all of that logic, plus custom rendering for the particle simulation. For that reason, deck.gl is best treated as a future interoperability layer rather than the foundation of the core library.

Polar and globe support are also part of the decision. deck.gl's default Web Mercator viewport follows the usual Mercator pole limitation, and its `GlobeView` is still documented as experimental with restrictions around pitch, bearing, high zoom precision, and some layer types:

- https://deck.gl/docs/api-reference/core/web-mercator-viewport
- https://deck.gl/docs/api-reference/core/globe-view
- https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre

For ice and polar datasets above 85 degrees, the current priority is to keep a small MapLibre-native renderer that can be validated directly against those requirements. A later `ZarrScalarDeckLayer` or `ZarrParticleDeckLayer` could reuse the same Zarr source, catalog, query, and caching code.

## Catalog Metadata

To validate the built-in catalog:

```bash
npm run catalog:validate
```

To add or update catalog entries:

```bash
uv run scripts/catalog_builder/skills/list_layers.py
uv run scripts/catalog_builder/skills/search_products.py wave
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id>
uv run scripts/catalog_builder/skills/validate_catalog.py
```

This requires Python >= 3.12, [uv](https://docs.astral.sh/uv/), and a free [Copernicus Marine](https://data.marine.copernicus.eu/register) account.

## Dataset Scope

The built-in catalog focuses on Copernicus Marine ARCO products, including ocean currents and scalar ocean/ice variables. Other Zarr v2 stores can be used when their store URLs and variables are described in a compatible catalog entry. Time, vertical, spatial, and variable metadata are loaded live from consolidated Zarr metadata and coordinate chunks.

Good fits include:

- Ocean currents, Stokes drift, and wave fields
- Sea-ice drift and ice-related scalar products
- Atmospheric wind or pressure-level products
- Climate model outputs with time and vertical dimensions
- Hydrodynamic model rasters or vectors

Vector layers need either U/V component variables or a catalog derivation from direction and magnitude. Scalar layers need one numeric variable and enough coordinate metadata to locate chunks by longitude, latitude, time, and optional vertical dimension.

## How It Works

### 1. Zarr Is A Multidimensional Raster Cube

Think of a Cloud Optimized GeoTIFF extended into longitude, latitude, time, and depth or pressure. The data is split into chunks. Zartigl requests only the chunks that intersect the current viewport at the selected time and vertical coordinate, similar to a COG tile request.

### 2. Chunks Become GPU Textures

Scalar chunks are normalized into a raster texture and colorized by the selected palette. Vector chunks are converted into a two-channel field texture, with validity carried as a mask.

For vector U/V data:

```txt
R = eastward component
G = northward component
A = valid data mask
```

### 3. Particles Are Virtual Drifters

For vector particle rendering, thousands of virtual drifters are seeded across the viewport. Every frame, the GPU samples the vector texture, moves each particle, and respawns particles that leave the valid domain.

Particle state lives in GPU textures using a ping-pong framebuffer pattern, so positions do not need to round-trip through CPU arrays each frame. Positions are stored at full float precision where the GPU supports it (falling back to 16-bit packing), which keeps trails crisp when zoomed in. Motion is zoom-compensated so a single `speed` setting yields roughly constant *visual* speed from low to high zoom.

### 4. Queries Use The Same Source Logic

Point inspection, time-series sampling, and vertical-profile sampling reuse the same Zarr metadata, coordinate lookup, chunk decoding, and cache machinery as the renderer. The query API is intentionally separate from the visual interaction layer, so applications can build their own analysis UI.

## Build And Release Checks

```bash
npm test
npm run build:prod
npm run build:lib
npm run catalog:validate
```

`npm run release:check` runs the main validation path before publishing.

## License

MIT
