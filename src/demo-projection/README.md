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
- **zartigl particles on the sphere.** The renderer is zartigl's particle
  pipeline (`lib/ParticleSimulation`): each frame, particles advance, a few
  respawn at random, one opaque segment per particle is drawn into a screen
  texture, and that texture fades a little, which builds the trails. Here the
  particles live as unit vectors (`SphereParticles.ts`) and move in the local
  east/north tangent plane, so every projection works and there is no
  singularity at the poles. Segments are projected with the current view
  (`shaders/draw.vert.glsl`).
- **Camera motion.** Screen trails cannot follow a moving view. As in
  zartigl, they clear quickly while the view moves (`lib/trail-fade`), and a
  drop-rate boost spreads the particles over the new view.
- **Versor dragging.** Quaternion rotation (`versor.ts`) keeps the grabbed
  point under the pointer on every projection.
- **Timeline as a jog wheel.** Scrubbing cancels stale decodes, and the
  particles flow on the field at the playhead as soon as its frames are
  decoded. Pause holds the image. After a view change, a scrub or a new
  layer, particles animate for about one trail length to rebuild trails,
  then hold again.
- **Share.** A readable url hash (`share.ts`) restores layer, time,
  projection, rotation, zoom and play state.

## Reused from zartigl

- The catalog: layers, provenance and per-layer particle defaults.
- The GeoVideo archive index and monthly chunks (`lib/geovideo-index`) and
  manifests (`lib/geovideo`).
- Frame-accurate vector-luma decoding (`lib/GeoVideoVectorSource`).
- Color ramps (`lib/gl-util`).
- The particle look: speed, drop rates, trail fade and camera-motion fade
  (`lib/trail-fade`, shaders adapted from `lib/shaders`).

## New here

These parts are specific to this demo and independent of Maplibre:

- the blended projections in d3 and GLSL;
- the sphere-space particle state, projected with any blended projection;
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
