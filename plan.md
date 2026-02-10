# zartigl — MVP Build Plan

> A MapLibre GL JS plugin for rendering animated particle flow from Zarr-based ocean current data directly in the browser.

**Repo**: `fxi/zartigl`
**Demo**: GitHub Pages at `fxi.github.io/zartigl`
**Stack**: TypeScript, Vite, MapLibre GL JS
**Dataset**: Copernicus Marine `GLOBAL_ANALYSISFORECAST_PHY_001_024` — `uo`/`vo` (surface current velocity)

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
  Copernicus ARCO Zarr (S3/HTTP) or static fallback
```

Modules are independent: `ZarrSource` knows nothing about WebGL, `ParticleSimulation` knows nothing about Zarr. The `ParticleLayer` wires them together behind MapLibre's `CustomLayerInterface`.

---

## 2. Phases

### Phase 1 — Scaffolding & Zarr loading

**Goal**: Fetch and decode U/V velocity chunks from Copernicus Zarr in the browser.

1. **Project setup**
   - Vite + TypeScript, `src/lib/` (plugin) + `src/demo/` (app)
   - Dual build: library (ESM) + demo (GH Pages)

2. **ZarrSource**
   - Fetch `.zmetadata` (consolidated) to parse dimensions, chunk layout, compression
   - Resolve chunk key from `(variable, time_idx, depth_idx, lat_chunk, lon_chunk)`
   - Fetch + decompress chunks (zlib via `pako`) → `Float32Array`
   - Coordinate arrays: parse `time`, `depth`, `latitude`, `longitude`

3. **Data discovery & CORS**
   - Locate ARCO endpoint via `copernicusmarine describe`
   - If CORS blocks: pre-subset a global surface slice to static Zarr hosted with the demo

4. **Validate**: load one U + V chunk, log values to console

### Phase 2 — Particle system on the GPU

**Goal**: Smooth animated particles advected by the velocity field, rendered on the MapLibre map.

1. **VelocityField**
   - Accept U/V `Float32Array` chunks, geo-bounds, and data range
   - Stitch visible chunks into a single WebGL texture (RG = normalized U/V)
   - Rebuild on viewport change or time/depth change

2. **ParticleSimulation** (Agafonkin's webgl-wind approach)
   - Particle state as a float texture (positions encoded in RGBA)
   - **Update pass**: fragment shader samples velocity texture, integrates position, writes to ping-pong framebuffer
   - **Fade pass**: draw previous frame's screen texture at reduced opacity (trail persistence)
   - **Draw pass**: render particles as `GL_POINTS` at current positions, colored by speed
   - Particle aging: randomly reset a fraction each frame for uniform coverage
   - Speed factor scales with zoom level

3. **ParticleLayer** — `CustomLayerInterface`
   - `onAdd(map, gl)`: init shaders, textures, framebuffers
   - `render(gl, matrix)`: run update → fade → draw each frame
   - `prerender()`: handle velocity texture updates from new chunks
   - Expose: `setTime()`, `setDepth()`, `setParticleCount()`, `setSpeedFactor()`, `setOpacity()`

4. **Viewport-aware loading**
   - On `moveend`: compute which chunks intersect bounds, fetch missing, update velocity texture
   - LRU cache for decoded chunks
   - `AbortController` to cancel stale requests

### Phase 3 — Demo & polish

**Goal**: Working demo on GitHub Pages.

1. **Map**: MapLibre + dark basemap
2. **Controls**: time slider, depth selector, particle count slider
3. **URL hash state**: center/zoom/time/depth for sharing
4. **GH Actions**: auto-deploy demo on push to main

---

## 3. File structure

```
zartigl/
├── src/
│   ├── lib/
│   │   ├── index.ts
│   │   ├── ParticleLayer.ts        # MapLibre CustomLayerInterface
│   │   ├── ParticleSimulation.ts   # GPU particle update/render
│   │   ├── VelocityField.ts        # Chunk → GL texture stitching
│   │   ├── ZarrSource.ts           # Zarr fetch + decompress
│   │   ├── shaders/
│   │   │   ├── update.frag.glsl
│   │   │   ├── draw.vert.glsl
│   │   │   ├── draw.frag.glsl
│   │   │   ├── fade.vert.glsl
│   │   │   └── fade.frag.glsl
│   │   └── types.ts
│   └── demo/
│       ├── index.html
│       ├── main.ts
│       └── style.css
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## 4. Key technical decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Zarr library | Hand-rolled with `fetch` + `pako` | Zarr v2 is simple; avoids heavy dependencies |
| WebGL version | WebGL1 with framebuffer ping-pong | Maximum browser compat; WebGL2 upgrade path later |
| Multi-chunk strategy | Stitch into single viewport texture | Simpler shader logic; one draw call per frame |
| Particle state encoding | RGBA float texture (lon/lat in RG/BA) | 16-bit precision per axis, sufficient for flow viz |
| Colormap | Speed magnitude → color via 1D texture lookup | GPU-side, no CPU bottleneck |

---

## 5. Non-goals for MVP

- No raster/heatmap layer (post-MVP)
- No multi-resolution / ndpyramid
- No Zarr v3
- No antimeridian / polar handling
- No automated tests
- No server component
- No React/Vue wrappers

---

## 6. Success criteria

1. Animated ocean current particles visible on a MapLibre map
2. Particles follow real U/V velocity data from Copernicus Zarr
3. Smooth at 60fps with 65k particles on desktop
4. Time/depth switching reloads data without page refresh
5. Panning loads new chunks and particles fill the new viewport
6. Demo live at `fxi.github.io/zartigl`
7. `npm install zartigl` exports `ParticleLayer`

---

## 7. Future (post-MVP)

- **RasterLayer**: colormapped scalar fields (temperature, salinity)
- **ndpyramid**: multi-resolution for global→regional zoom
- **Time animation**: auto-play through timesteps
- **Arrow layer**: static arrow grid alternative
- **Mapbox GL JS compat**
- **React / Vue wrappers**