# zartigl

A MapLibre GL JS plugin for rendering animated particle flow from Zarr-based ocean current data directly in the browser.

[![Demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)](https://fxi.github.io/zartigl/)

## Features

- GPU-accelerated particle simulation (WebGL ping-pong framebuffers)
- Reads Zarr v2 stores directly in the browser (blosc + zlib decompression)
- Streams data from Copernicus Marine ARCO S3 — no local data or server needed
- Viewport-aware chunk loading with LRU cache
- Speed-based particle coloring via configurable color ramp
- Trail rendering with adjustable fade opacity

## Quick start

```bash
npm install zartigl maplibre-gl
```

```ts
import maplibregl from "maplibre-gl";
import { ParticleLayer } from "zartigl";

const map = new maplibregl.Map({ container: "map", style: "..." });

map.on("load", () => {
  map.addLayer(
    new ParticleLayer({
      id: "currents",
      source: "https://your-zarr-store/",
      variableU: "uo",
      variableV: "vo",
    }),
  );
});
```

## Demo

```bash
npm install
npm run dev
```

The demo reads a catalog (`public/data/catalog.json`) that points to the [Copernicus Marine ARCO Zarr store](https://help.marine.copernicus.eu/en/articles/12332770-introduction-to-the-arco-format) on S3. No local data download is needed — chunks are fetched directly from Copernicus (public, CORS enabled).

To update the catalog metadata:

```bash
cd scripts
uv run build_catalog.py
```

This requires Python >= 3.12, [uv](https://docs.astral.sh/uv/), and a free [Copernicus Marine](https://data.marine.copernicus.eu/register) account.

## Dataset

[GLOBAL_ANALYSISFORECAST_PHY_001_024](https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024) from Copernicus Marine Service — `uo`/`vo` surface current velocity at ~0.083deg resolution, streamed as ARCO Zarr directly from Copernicus S3.

## Other use cases

Any 2D vector field stored as U/V components in a Zarr store works as a source. Examples:

- **Atmospheric wind** — reanalysis products (ERA5, MERRA-2) or NWP model output; visualise jet streams, storm tracks, or surface winds at any pressure level
- **Ocean surface waves** — Stokes drift or wave propagation direction fields
- **Ice drift** — sea-ice motion vectors from passive microwave retrievals
- **River discharge / flood routing** — depth-averaged U/V from hydrodynamic models (Delft3D, SCHISM)
- **Air quality transport** — horizontal advection of pollutant plumes from dispersion models
- **Climate projections** — CMIP6 ocean or atmosphere circulation at any time slice; compare historical vs. SSP scenarios
- **Groundwater flow** — Darcy velocity fields from subsurface models
- **Wildfire smoke** — wind-driven particle transport overlaid on active fire data

The only requirement is a Zarr v2 store with two named float variables representing the east and north components of the field.

## How it works

A plain-language walkthrough for GIS analysts unfamiliar with WebGL or Zarr.

### 1. Zarr is a tiled raster cube

Think of a Cloud Optimized GeoTIFF extended into four dimensions: longitude × latitude × depth × time. The data is split into chunks — here: 1 time step × 1 depth level × 512 rows × 2048 columns. Zartigl requests only the chunks that intersect the current viewport at the selected time and depth, exactly like a COG tile request.

### 2. Velocity becomes a two-channel raster

Each chunk holds two float arrays — **U** (eastward m/s) and **V** (northward m/s). These are normalized and packed into the R and G channels of an image uploaded to the GPU:

```
R = eastward velocity  (0 → max west, 128 → still, 255 → max east)
G = northward velocity
A = 255 (ocean) | 0 (land / nodata)   ← validity mask
```

The result is a global velocity raster in GPU memory. The alpha channel is a nodata mask.

### 3. Particles are virtual drifters

Thousands of virtual oceanographic drifters are seeded randomly across the viewport. Every frame (~60 fps), the GPU runs this logic for all of them simultaneously:

> *Where am I? → sample the velocity raster at my position → move a tiny step in that direction → if I drift off-screen or hit land (A = 0), teleport to a random ocean pixel inside the viewport.*

Same logic as a drift model — just running on 65 000+ drifters at 60 frames per second.

### 4. Trails are faded time-lapse

Before each new frame, the previous frame is multiplied by ~0.9999. Particles leave a fading streak — like a long-exposure photograph of drifters. Streak length encodes time; color encodes speed magnitude via a configurable color ramp.

### 5. Particle state lives in GPU memory

Drifter positions are never stored in a CPU array. They are encoded as pixel colors in a GPU texture (X → red, Y → blue, sub-pixel precision in the low byte). Two textures alternate each frame — read from A, write to B, swap — so the GPU never waits on itself. This is the **ping-pong** pattern.

### Pipeline at a glance

| Step | What happens | GIS analogy |
|---|---|---|
| Fetch | Request Zarr chunks for viewport + time + depth | COG tile request |
| Pack | Encode U/V floats into R/G/A texture | Raster → GPU image |
| Seed | Place N drifters randomly in viewport | Random point sampling |
| Advect | Each frame: sample velocity, move each drifter | Drift model at 60 fps |
| Mask | Discard drifters over land (A = 0) | Nodata mask |
| Fade | Dim previous frame slightly | Long-exposure photography |
| Color | Map speed to color ramp | Graduated color by value |
| Composite | Blend result over basemap | Raster layer blending |

## License

MIT
