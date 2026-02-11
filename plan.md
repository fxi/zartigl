# zartigl — MVP Build Plan

> A MapLibre GL JS plugin for rendering animated particle flow from Zarr-based ocean current data directly in the browser.

**Repo**: `fxi/zartigl`
**Demo**: GitHub Pages at `fxi.github.io/zartigl`
**Stack**: TypeScript, Vite, MapLibre GL JS
**Data source**: Copernicus Marine ARCO Zarr stores (public S3, no auth, CORS enabled)

---

## 1. Architecture

```
Demo App (Vite + MapLibre)
  │
  ▼
ParticleLayer  ← CustomLayerInterface
  │
  ├── VelocityField     (stitches U/V chunks into GPU textures)
  ├── ParticleSimulation (ping-pong framebuffer advection)
  └── ZarrSource         (fetch + decompress Zarr chunks)
          │
          ▼
  public/data/catalog.json  → resolves Zarr store URL
          │
          ▼
  Copernicus ARCO Zarr on S3 (direct HTTP, CORS: *)
  https://s3.waw3-1.cloudferro.com/mdl-arco-time-009/arco/...
```

Modules are independent: `ZarrSource` knows nothing about WebGL, `ParticleSimulation` knows nothing about Zarr. The `ParticleLayer` wires them together behind MapLibre's `CustomLayerInterface`.

**Data pipeline**: No local data. A Python script queries the Copernicus Marine catalog and writes `catalog.json` with S3 URLs, chunk layouts, and available time/depth ranges. The browser reads this catalog, then fetches `.zmetadata` and chunks directly from Copernicus S3.

---

## 2. Data pipeline

### Copernicus ARCO Zarr — confirmed working

The Copernicus Marine Data Store serves all datasets as ARCO (Analysis-Ready Cloud-Optimized) Zarr v2 stores on public S3:

- **Public, no auth required**
- **CORS enabled**: `access-control-allow-origin: *`
- **Standard Zarr v2** with consolidated `.zmetadata`
- **Two chunking strategies per dataset**:
  - `timeChunked.zarr` — chunks: `[1, 1, 512, 2048]` (1 time, 1 depth, large spatial) → best for map rendering
  - `geoChunked.zarr` — chunks: `[526, 1, 32, 32]` (many times, 1 depth, small spatial) → best for time series

For the current dataset (`cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i`):

| Property | Value |
|----------|-------|
| Base URL | `https://s3.waw3-1.cloudferro.com/mdl-arco-time-009/arco/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i_202406/timeChunked.zarr` |
| Shape | `[5445, 50, 2041, 4320]` (time, elevation, lat, lon) |
| Chunks | `[1, 1, 512, 2048]` |
| Compressor | **blosc** (lz4, clevel 5, shuffle) |
| Dtype | `float32` |
| Dimensions | `time`, `elevation`, `latitude`, `longitude` |
| Chunks per global surface slice | 24 (12 per variable, 4 lat x 3 lon) |
| Chunk size | ~2.5–3 MB compressed |
| Fetch time per chunk | ~0.4s |

### Catalog script (`scripts/build_catalog.py`)

Replaces `scripts/subset_zarr.py`. Uses `copernicusmarine describe` to generate `public/data/catalog.json`:

```json
{
  "generated": "2026-02-11T...",
  "datasets": [
    {
      "id": "cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i",
      "product": "GLOBAL_ANALYSISFORECAST_PHY_001_024",
      "label": "Global Ocean Currents (analysis+forecast)",
      "zarr_url": "https://s3.waw3-1.cloudferro.com/mdl-arco-time-009/arco/.../timeChunked.zarr",
      "variables": {
        "uo": { "standard_name": "eastward_sea_water_velocity", "units": "m s-1" },
        "vo": { "standard_name": "northward_sea_water_velocity", "units": "m s-1" }
      },
      "dimensions": {
        "time": { "size": 5445, "step_ms": 21600000, "min_ms": 1654041600000, "max_ms": 1771632000000 },
        "elevation": { "values": [0.494, 1.541, 2.646, ...] },
        "latitude": { "min": -80, "max": 90, "step": 0.0833, "size": 2041 },
        "longitude": { "min": -180, "max": 179.917, "step": 0.0833, "size": 4320 }
      },
      "chunks": { "time": 1, "elevation": 1, "latitude": 512, "longitude": 2048 },
      "compressor": { "id": "blosc", "cname": "lz4", "clevel": 5, "shuffle": 1 }
    }
  ]
}
```

To update the catalog: `cd scripts && uv run build_catalog.py` → commits `public/data/catalog.json`.

For MapX: the catalog would be stored as a config/env variable, and the mirror proxy would prefix the zarr_url: `https://api.mapx.org/get/mirror?url=<encoded zarr_url>/chunk/path`.

---

## 3. Phases

### Phase 1 — Scaffolding & Zarr loading ✅ (done, needs update)

**Goal**: Fetch and decode U/V velocity chunks from Copernicus Zarr in the browser.

1. **Project setup** ✅
   - Vite + TypeScript, `src/lib/` (plugin) + `src/demo/` (app)
   - Dual build: library (ESM) + demo (GH Pages)

2. **ZarrSource** ✅ (needs blosc support)
   - Fetch `.zmetadata` (consolidated) to parse dimensions, chunk layout, compression
   - Resolve chunk key from `(variable, time_idx, depth_idx, lat_chunk, lon_chunk)`
   - Fetch + decompress chunks → `Float32Array`
   - Coordinate arrays: parse `time`, `elevation`, `latitude`, `longitude`

3. **Data discovery** ✅ (confirmed)
   - ARCO S3 endpoints are public with CORS `*`
   - No local data needed; catalog.json provides URL + metadata

### Phase 1b — Refactor to remote ARCO ← **current**

**Goal**: Remove local Zarr store, read directly from Copernicus S3 via catalog.

1. **Catalog script** (`scripts/build_catalog.py`)
   - Query `copernicusmarine describe` for target datasets
   - Write `public/data/catalog.json` with S3 URLs, dimensions, chunk layout
   - Remove `scripts/subset_zarr.py`

2. **Add blosc decompression to ZarrSource**
   - Current: zlib only (via `pako`)
   - Needed: blosc (lz4) — use `blosc-js` or `numcodecs` WASM build
   - Keep zlib support as fallback

3. **Handle dimension naming**
   - ARCO stores use `elevation` instead of `depth`
   - ZarrSource should handle both (or catalog normalizes this)

4. **Demo reads catalog → remote Zarr**
   - `main.ts` fetches `catalog.json`, picks dataset, passes `zarr_url` to `ZarrSource`
   - Optional: configurable mirror proxy URL for MapX deployment

5. **Remove `public/data/` Zarr files** (depth/, latitude/, longitude/, time/, uo/, vo/)

### Phase 2 — Particle system on the GPU ✅ (done)

**Goal**: Smooth animated particles advected by the velocity field, rendered on the MapLibre map.

1. **VelocityField** ✅
   - Accept U/V `Float32Array` chunks, geo-bounds, and data range
   - Stitch visible chunks into a single WebGL texture (RG = normalized U/V)
   - Rebuild on viewport change or time/depth change

2. **ParticleSimulation** ✅ (Agafonkin's webgl-wind approach)
   - Particle state as a float texture (positions encoded in RGBA)
   - **Update pass**: fragment shader samples velocity texture, integrates position, writes to ping-pong framebuffer
   - **Fade pass**: draw previous frame's screen texture at reduced opacity (trail persistence)
   - **Draw pass**: render particles as `GL_POINTS` at current positions, colored by speed
   - Particle aging: randomly reset a fraction each frame for uniform coverage
   - Speed factor scales with zoom level

3. **ParticleLayer** ✅ — `CustomLayerInterface`
   - `onAdd(map, gl)`: init shaders, textures, framebuffers
   - `render(gl, matrix)`: run update → fade → draw each frame
   - `prerender()`: handle velocity texture updates from new chunks
   - Expose: `setTime()`, `setDepth()`, `setParticleCount()`, `setSpeedFactor()`, `setOpacity()`

4. **Viewport-aware loading** ✅
   - On `moveend`: compute which chunks intersect bounds, fetch missing, update velocity texture
   - LRU cache for decoded chunks
   - `AbortController` to cancel stale requests

### Phase 3 — Demo & polish

**Goal**: Working demo on GitHub Pages.

1. **Map**: MapLibre + dark basemap ✅
2. **Controls**: time slider, depth selector, particle count slider
3. **URL hash state**: center/zoom/time/depth for sharing
4. **GH Actions**: auto-deploy demo on push to main

---

## 4. File structure

```
zartigl/
├── src/
│   ├── lib/
│   │   ├── index.ts
│   │   ├── ParticleLayer.ts        # MapLibre CustomLayerInterface
│   │   ├── ParticleSimulation.ts   # GPU particle update/render
│   │   ├── VelocityField.ts        # Chunk → GL texture stitching
│   │   ├── ZarrSource.ts           # Zarr fetch + decompress
│   │   ├── gl-util.ts              # WebGL helpers
│   │   ├── shaders/
│   │   │   ├── quad.vert.glsl
│   │   │   ├── update.frag.glsl
│   │   │   ├── draw.vert.glsl
│   │   │   ├── draw.frag.glsl
│   │   │   └── fade.frag.glsl
│   │   └── types.ts
│   └── demo/
│       ├── index.html
│       ├── main.ts
│       └── style.css
├── scripts/
│   └── build_catalog.py            # Generates catalog.json from Copernicus
├── public/
│   └── data/
│       └── catalog.json            # Dataset URLs + metadata (committed)
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## 5. Key technical decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data source | Copernicus ARCO S3 directly | Public, CORS enabled, no local data needed |
| Catalog | Static `catalog.json` in `public/data/` | Simple, versioned, updatable via script |
| Zarr library | Hand-rolled with `fetch` + `pako` + `blosc-js` | Zarr v2 is simple; avoids heavy dependencies |
| Compression | blosc (lz4) primary, zlib fallback | ARCO stores use blosc; local/custom stores may use zlib |
| WebGL version | WebGL1 with framebuffer ping-pong | Maximum browser compat; WebGL2 upgrade path later |
| Multi-chunk strategy | Stitch into single viewport texture | Simpler shader logic; one draw call per frame |
| Particle state encoding | RGBA float texture (lon/lat in RG/BA) | 16-bit precision per axis, sufficient for flow viz |
| Colormap | Speed magnitude → color via 1D texture lookup | GPU-side, no CPU bottleneck |
| CORS proxy (MapX) | `api.mapx.org/get/mirror?url=...` | Already exists; zarr_url from catalog is the source of truth |

---

## 6. Non-goals for MVP

- No raster/heatmap layer (post-MVP)
- No multi-resolution / ndpyramid
- No Zarr v3
- No antimeridian / polar handling
- No automated tests
- No server component
- No React/Vue wrappers

---

## 7. Success criteria

1. Animated ocean current particles visible on a MapLibre map
2. Particles follow real U/V velocity data fetched directly from Copernicus S3
3. No local data files — only `catalog.json` in the repo
4. Smooth at 60fps with 65k particles on desktop
5. Time/depth switching reloads data without page refresh
6. Panning loads new chunks and particles fill the new viewport
7. Demo live at `fxi.github.io/zartigl`
8. `npm install zartigl` exports `ParticleLayer`

---

## 8. Future (post-MVP)

- **Multi-dataset catalog**: script generates entries for all Copernicus ocean datasets
- **MapX integration**: catalog as env config, mirror proxy for CORS
- **RasterLayer**: colormapped scalar fields (temperature, salinity)
- **ndpyramid**: multi-resolution for global→regional zoom
- **Time animation**: auto-play through timesteps
- **Arrow layer**: static arrow grid alternative
- **Mapbox GL JS compat**
- **React / Vue wrappers**
