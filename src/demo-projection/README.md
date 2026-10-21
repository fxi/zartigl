# projversor

Standalone demo: every GeoVideo archive of the zartigl catalog, global or
regional (Mediterranean), on a sphere that morphs between world projections.
Vector archives (currents, wind, waves, sea ice) play as animated particles,
scalar ones (temperature, salinity, biogeochemistry, …) as a raster.

The renderer lives in `src/projversor/` and is published as
`@fxi/zartigl/projversor`: the `Projversor` class owns the canvases, the GL
context, archive loading and the view, and reports changes through events.
This demo is its controls (rail, pickers, timeline, legend, compass, share);
`../demo-story-projversor` is a story on the same renderer. Both use zartigl only
through its package entries (`../engine`, `../catalog`, `../projversor`,
`../story`); ESLint rejects deeper imports so they can move to their own
repository.

```bash
npm run dev:projection     # vite dev server
npm run build:projection   # dist-projection/, served under /zartigl/projversor/
```

## Container

The repository `Dockerfile` builds this demo and serves it at `/` with nginx
on port 8080, with the projversor story at `/story/`. Images are published to `ghcr.io/fxi/zartigl-projversor`
(`latest` from `main`, semver tags from releases).

```bash
docker compose up -d --build   # build locally, open http://localhost:8080
docker compose pull && docker compose up -d   # use the published image
```

## Technique

File names below are in `src/projversor/` unless noted.

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
- **Compositing and color grade.** The GL canvas is premultiplied and
  layers blend with `compositeBlend` (`view.ts`), so faded trails keep their
  coverage. The cog in the actions row at the foot of the rail
  (with projection and share) opens zartigl's optional particle color
  grade (`lib/color-grade`: exposure, contrast, saturation, highlights),
  applied in the existing trail composite pass, so it toggles live at no extra
  pass cost.
- **Camera motion.** Screen trails cannot follow a moving view. As in
  zartigl, they clear quickly while the view moves (`lib/trail-fade`), and a
  drop-rate boost spreads the particles over the new view.
- **Scalar rasters.** A scalar layer is drawn as a lon/lat mesh over its
  grid bounds (`SphereScalar.ts`), projected with the current view like the
  particles (`shaders/raster.vert.glsl`), so it morphs with the projections.
  A triangle crossing a projection cut is dropped; one past the clip is
  trimmed per pixel. Colors come from the catalog palette over the manifest
  color domain.
- **Regional grids.** Fields sample their grid only inside its bounds
  (`shaders/grid.glsl`), and opening a regional layer centers the view on it.
- **Versor dragging.** Quaternion rotation (`versor.ts`) keeps the grabbed
  point under the pointer on every projection.
- **Two-variable layers.** Any scalar layer can color the particles of a
  vector one (the droplet picker; some layers default to one in `layers.ts`):
  its GeoVideo archive is decoded frame by frame
  (`lib/GeoVideoScalarSource`) next to the vector one, months paired by
  calendar period (`lib/archive-timeline`), and particles take their color from it (`shaders/tint.glsl`)
  while speed sets their brightness. "Currents × Temperature" pairs ocean
  currents with sea water temperature from the same Copernicus model,
  globally and in the Mediterranean.
- **North up by default.** As d3-geo-zoom's `northUp`, drags keep the roll
  (gamma) at zero. The compass (this demo's `Compass.ts`, with `bearing.ts`) shows the
  bearing; dragging around it or the arrow keys free and set the bearing,
  and a click eases back to north up and locks it again.
- **Timeline as a jog wheel.** Scrubbing cancels stale decodes, and the
  particles flow on the field at the playhead as soon as its frames are
  decoded. Pause holds the image. After a view change, a scrub or a new
  layer, particles animate for about one trail length to rebuild trails,
  then hold again.
- **Share.** A readable url hash (`share.ts`) restores layer, time,
  projection, rotation, zoom, play state, speed, tint and the style
  override (`st`: palette and particle grade, the zartigl layer style).
  Older links' palette (`c`) and grade (`g`) still open.

## Reused from zartigl

- The catalog: the layer list (every entry with a GeoVideo archive), titles,
  palettes, provenance, raster opacity and per-layer particle defaults.
  `layers.ts` only adds a layer style (palette) and tinted pairings.
- The GeoVideo archive index and monthly chunks (`lib/geovideo-index`) and
  manifests (`lib/geovideo`).
- Frame-accurate vector and scalar luma decoding (`lib/GeoVideoVectorSource`,
  `lib/GeoVideoScalarSource`) and chunk pairing (`lib/archive-timeline`).
- Color ramps (`lib/gl-util`).
- The particle look: speed, drop rates, trail fade and camera-motion fade
  (`lib/trail-fade`, shaders adapted from `lib/shaders`).

## New here

These parts are specific to this demo and independent of Maplibre:

- the blended projections in d3 and GLSL;
- the sphere-space particle state and scalar raster mesh, projected with any
  blended projection;
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
