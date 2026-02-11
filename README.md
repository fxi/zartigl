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

## License

MIT
