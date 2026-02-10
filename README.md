# zartigl

A MapLibre GL JS plugin for rendering animated particle flow from Zarr-based ocean current data directly in the browser.

![zartigl demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)

## Features

- GPU-accelerated particle simulation (WebGL ping-pong framebuffers)
- Reads Zarr v2 stores directly in the browser (zlib decompression via pako)
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

### Prerequisites

- Node.js >= 18
- Python >= 3.12 + [uv](https://docs.astral.sh/uv/)
- A free [Copernicus Marine](https://data.marine.copernicus.eu/register) account

### Generate the data

```bash
cd scripts
uv run copernicusmarine login
uv run python subset_zarr.py
```

This downloads the latest global surface current forecast from Copernicus Marine, coarsens it to ~0.25deg, and writes a ~5 MB Zarr store to `public/data/`.

### Run the demo

```bash
npm install
npm run dev
```

Open http://localhost:5173 to see animated ocean current particles on a dark basemap.

## Dataset

[GLOBAL_ANALYSISFORECAST_PHY_001_024](https://data.marine.copernicus.eu/product/GLOBAL_ANALYSISFORECAST_PHY_001_024) from Copernicus Marine Service -- `uo`/`vo` surface current velocity at ~0.083deg resolution, subsetted and coarsened for browser use.

## License

MIT
