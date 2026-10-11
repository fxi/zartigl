# projversor

Standalone demo: global GeoVideo vector archives (ocean currents, wind,
waves, sea ice) played as animated particles on a sphere that morphs between
world projections.

```bash
npm run dev:projection     # vite dev server
npm run build:projection   # dist-projection/, served under /zartigl/projversor/
```

## Technique

- **Twin projections.** Each projection exists twice, as a d3 raw formula
  (`projections.ts`) and in GLSL (`shaders/project.glsl`). The canvas overlay
  (land, graticule, outline) and the WebGL layers project through the same
  maths, so coastlines stay on the data. A transition blends two raw
  projections point by point, which makes the morph smooth.
- **Raster.** A lon/lat mesh of the rotated frame (`ProjectedRaster.ts`) is
  projected in the vertex shader. Its border is the cut of every projection,
  so no triangle crosses a discontinuity.
- **Particles on the sphere.** Particles live as unit vectors
  (`SphereParticles.ts`) and are advected in the local east/north tangent
  plane. There is no singularity at the poles and no Mercator. Each step
  writes a ring-buffer history layer, and trails are drawn from that history,
  so they reproject with the view instead of smearing on screen.
- **Versor dragging.** Quaternion rotation (`versor.ts`) keeps the grabbed
  point under the pointer on every projection.
- **Timeline as a jog wheel.** Scrubbing cancels stale decodes. Particles are
  rebuilt with fixed seeds at the playhead, so the same time and view always
  give the same image. Pause freezes them.
- **Share.** A readable url hash (`share.ts`) restores layer, time,
  projection, rotation, zoom and play state.

## Reused from zartigl

- The catalog: layers, provenance and per-layer particle defaults.
- The GeoVideo archive index and monthly chunks (`lib/geovideo-index`) and
  manifests (`lib/geovideo`).
- Frame-accurate vector-luma decoding (`lib/GeoVideoVectorSource`).
- Color ramps (`lib/gl-util`).

## New here

These parts are specific to this demo and independent of Maplibre:

- the blended projections in d3 and GLSL;
- the sphere-space particle simulation and its trails;
- the versor interaction;
- the timeline behavior;
- the shareable view.

## Inspiration and similar projects

- [mapped.earth](https://mapped.earth/).
- This [Instagram post](https://www.instagram.com/p/DeUCMxjiA_U/).
- [earth.nullschool.net](https://earth.nullschool.net) by Cameron Beccario:
  wind and currents over many projections.
- [webgl-wind](https://github.com/mapbox/webgl-wind) by Vladimir Agafonkin:
  GPU particle advection with textures.
- Mike Bostock and Jason Davies' d3 work on projection transitions and versor
  dragging.
- [Windy](https://www.windy.com) and NASA's
  [Perpetual Ocean](https://svs.gsfc.nasa.gov/3827), for the look.
