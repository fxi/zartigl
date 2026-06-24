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

## Alternatives And Project Fit

Zartigl overlaps with several useful projects. The goal is not to replace them, but to cover a specific MapX/ARCO workflow: public cloud Zarr stores, MapLibre integration, animated vector particles, scalar rasters, time/depth controls, point inspection, and reproducible widget configuration without a dedicated tile server.

The table below is a fit matrix based on documented project scope. "Not specified" means the feature is not a stated focus in the referenced project, not that it is impossible.

| Project | Best fit | Zarr raster | Vector particles | Time/depth UI | Query API | Polar/globe rendering | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| zartigl | MapX-ready ARCO-like ocean layers | Yes, Zarr v2 | Yes | Built in | Time series and vertical profiles when a point-series store is available | MapLibre globe/ECEF path for lon/lat scalar and vector layers, including over-pole views | Catalog defaults, WMTS fallback for selected scalar layers, MapX snippet generation |
| [Copernicus Marine MyOcean Pro](https://data.marine.copernicus.eu/viewer/expert) | Copernicus end-user exploration | Service-managed | Product-dependent | Application UI | Product UI, not a reusable library API | Service-managed | Reference viewer, not a MapLibre/WebGL library to embed in MapX |
| [@carbonplan/zarr-layer](https://github.com/carbonplan/zarr-layer) | General Zarr raster layers for MapLibre/Mapbox | Yes, Zarr v2/v3 | No, raster-focused | Selector API | GeoJSON queries | Full polar coverage documented for MapLibre with suitable untiled datasets | Strong closest alternative for raster Zarr; supports custom stores, CRS reprojection, custom fragment shaders |
| [@carbonplan/maps](https://github.com/carbonplan/maps) | React maps for prepared multidimensional rasters | Yes, prepared Zarr pyramids | No | React selector workflow | Not its main focus | Web Mercator-focused | Higher-level React framework; its core MapLibre path is documented as Web Mercator-only |
| [zarr-gl](https://github.com/carderne/zarr-gl) | Lightweight Zarr layer for Mapbox/MapLibre | Yes | No | Limited | Not specified | Not specified | The README now recommends using `@carbonplan/zarr-layer` instead |
| [maplibre-gl-wind](https://github.com/geoql/maplibre-gl-wind) | Wind particle layer for deck.gl/MapLibre | No | Yes | No | No | Not specified | Takes wind textures or point data, not Zarr metadata/chunks |

The closest general alternative is `@carbonplan/zarr-layer`. It has a broader documented scope for raster Zarr rendering: Zarr v2/v3, custom stores, CRS reprojection, custom fragment shaders, GeoJSON queries, and full polar coverage in MapLibre for suitable untiled datasets. If the requirement were only "draw a multidimensional Zarr raster on a MapLibre map", using or contributing to `@carbonplan/zarr-layer` would be a strong option.

Zartigl remains useful because it combines pieces that are not currently covered together by those projects:

- ARCO-oriented catalog entries and defaults for Copernicus Marine products.
- U/V vector products rendered as animated particles, with optional raster magnitude in the same layer.
- Time and vertical-axis metadata exposed as application controls.
- Depth/elevation labeling, ordering, and point inspection tuned for ocean products.
- MapLibre globe rendering for both scalar and vector fields, including polar scenes beyond the usual Web Mercator `85.0511°` latitude limit.
- GPU particle-state fallbacks for browser and hardware differences, including float, half-float, and `RGBA8` compatibility mode.
- A facade API that can generate MapX widget snippets and keep widget state reproducible.

deck.gl, Three.js, or `@carbonplan/zarr-layer` could still be useful integration targets. They would not remove the ARCO catalog, time/depth metadata, vector particle simulation, point-query workflow, or MapX widget-state work that zartigl currently owns.

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

Trail history currently remains a screen-space texture. During camera movement it is faded aggressively rather than cleared every frame, which avoids flicker while limiting displaced trail artifacts on both Mercator and globe projections. A world-aligned or reprojected trail buffer is a possible experimental direction, but globe reprojection and polar continuity require additional work.

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
