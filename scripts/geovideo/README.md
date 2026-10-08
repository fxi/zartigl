# GeoVideo renderer

GeoVideo turns a scalar catalog layer into an equirectangular, streamable MP4
plus a spatial/temporal JSON manifest. GeoVideo stores quantized values in H.264
luminance and keeps a static validity mask in a separate lossless PNG. The
browser applies palette and scalar styling in WebGL.

GeoVideo configurations do not duplicate scalar style. Palette, color domain,
log scale, and vibrance resolve from the catalog entry; units resolve from the
underlying Zarr variable. For Copernicus entries those catalog defaults come
from the provider's default WMTS JSON legend. `--dry-run` prints the resolved
style.

Published manifests use GeoVideo schema version 3. Their provenance records the
catalog entry UUID, the input source UUID, provider/native identifiers, source
variable IDs, and generation timestamp. Catalog aliases and translated labels
are intentionally absent from artifact identity.

```bash
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json --dry-run
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json --upload
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json --upload-only
```

The Arctic sea-ice example covers the full currently available daily timeline
(`2022-06-01` through `2026-08-27`) in an 80-second polar animation:

```bash
uv run scripts/geovideo/render.py scripts/geovideo/examples/sea-ice-thickness-arctic.json --dry-run
uv run scripts/geovideo/render.py scripts/geovideo/examples/sea-ice-thickness-arctic.json --upload
```

The Baltic bottom-oxygen example selects every exact monthly mean from September
1993 through September 2025 and records those timestamps as a discrete
`sample-sequence` timeline:

```bash
uv run scripts/geovideo/render.py scripts/geovideo/examples/baltic-bottom-oxygen-monthly.json --dry-run
uv run scripts/geovideo/render.py scripts/geovideo/examples/baltic-bottom-oxygen-monthly.json --upload
```

Its `sampling.kind: "monthly"` configuration requires `dateStart`, `dateEnd`,
and a positive integer `framesPerSample`. This profile repeats each real monthly
field for two frames at 24 fps: 12 months per second and about 32 seconds total.
Missing or duplicate months abort the render instead of inventing dates or
interpolating values. The reusable `annual-month` mode remains available for
one exact calendar month per year.

`ffmpeg` must be available in `PATH`. Upload reads S3 credentials from `.env`;
credentials are never written to the artifact. Public endpoint and bucket
defaults come from `.env.demo`. Override `upload.publicBaseUrl` for a CDN or a
virtual-hosted bucket URL.

GeoVideo duration is not limited to 30 seconds. Longer videos increase render
time and artifact size linearly; the current Arctic profile produces 1,920
frames at 24 fps and may reach roughly 160 MB at the 16 Mbit/s bitrate ceiling.
The renderer keeps one static validity mask for the whole animation, so pixels
whose validity changes over time are conservatively excluded.

The production scalar profile defaults to CRF 12 and a 16 Mbit/s ceiling. Both
are part of the immutable artifact configuration; generated media is decoded
and sampled against the input codes, and publication is refused unless its
recorded field-error budget passes (p99 at most eight codes and maximum at most
16). This field budget is separate from the stricter two-code browser criterion
for stable ramps.

If a render fails the field-error budget on a visually busy or high-variance
dataset, try raising `output.maxBitrate` before lowering `crf`. A lower CRF
asks for more bits than a fixed bitrate ceiling allows, so on a hard frame it
can starve the encoder further and increase the max error rather than
reduce it; giving the encoder more headroom at the standard CRF fixes this
class of failure. `sst-anomaly.json`'s `maxBitrate: "24M"` is a resolved
instance of this.

Set `output.tune: "psnr"` for archives: it disables x264's psychovisual
tuning, which trades numeric fidelity for perceived quality. Exact daily SST
anomaly fields failed the budget (max 17–20) at CRF 10–12 whatever the
ceiling, because the 16M VBV buffer starves low CRF; CRF 8 with a 48M ceiling
and `tune: psnr` passes with margin (max ≈ 11) at about 6 MB per month.

`report.json` also records source extrema and counts outside the provider
display domain. Those values follow the provider's declared clamp semantics;
GeoVideo reports them without inventing a scientific correction.

Single artifacts referenced by `manifestUrl` are not checked against later
catalog changes: after changing `defaults.raster.colorDomain` for such an
entry, re-render, re-upload, and update `manifestUrl` by hand. Archive sources
(below) detect and repair this drift themselves.

For a cheap end-to-end check, copy the example, lower its resolution/duration,
and pass `--max-frames 2`. `--max-frames` is intentionally a smoke-test option:
the resulting shortened media retains the requested timeline in its manifest
and must not be published as a production artifact.

## Scalar-luma calibration

`calibrate.py` generates a deterministic scalar value video, round-trips it
through the production H.264 settings, and reports code stability and error:

```bash
npm run geovideo:calibrate
```

Outputs are written below `artifacts/geovideo-calibration/` and are ignored by
Git. These statistics cover FFmpeg decoding; browser canvas/WebGL calibration is
still required before adopting scalar-encoded video as a public format.

GeoVideo is a visualization transport. Point clicks, time series, and depth
profiles always query the catalog's authoritative Zarr store; decoded video
values are never exposed as scientific samples. Vector layers remain Zarr-only.
The lossless static mask is the intersection of validity over all encoded
frames. Pixels whose validity changes are conservatively hidden for the whole
animation, and their count is recorded as `maskValidation.varyingPixelsExcluded`
in `report.json`.

Use `--crf`, `--max-bitrate`, `--frames`, `--width`, and `--height` to compare
profiles. The defaults exercise the current production dimensions and codec
settings; for example:

```bash
uv run scripts/geovideo/calibrate.py --frames 12 --crf 12 --max-bitrate 16M
```

Then exercise the production video → WebGL path through readback:

```bash
uv run scripts/geovideo/browser_calibrate.py
```

The harness checks at least 128 stable ramp levels, a maximum stable-ramp error
of two codes, no temporal flicker, and an exact canvas/WebGL upload round trip.
Run the HTML harness manually against the same artifact in Safari and Firefox
before publishing a scalar-luma catalog artifact.

## Vector-luma GeoVideo

`render_vector.py` turns a vector catalog entry (u/v or direction/magnitude)
into a `vector-luma` artifact. Each native time step becomes one H.264 frame
(High profile, level 4.1, decodable in hardware on desktop, iOS Safari and
Android). u and v are block-averaged (`output.factor`), mapped with a sqrt
transfer to limited-range codes 16–235 and written straight into luma, u rows
above v rows. The browser decodes one frame per time step through
`GeoVideoVectorSource` (no continuous playback) and feeds the regular particle
renderer with a fixed `valueDomain`.

```bash
uv run scripts/geovideo/render_vector.py scripts/geovideo/examples/swell-2026-08-09.json --dry-run
uv run scripts/geovideo/render_vector.py scripts/geovideo/examples/swell-2026-08-09.json --upload
```

Configuration (see `examples/*-2026-08-09.json`):

- `dateStart`/`dateEnd`: fixed period; `step` (`PTnH`/`PnD`) subsamples the
  native cadence.
- `output.factor` (block size), `crf` (14), `gop` (12), `fps` (4), `transfer`
  (`sqrt`).
- `output.domainPercentile` (99.9 by default): percentile of |u|,|v| used as
  `valueDomain`. Use 100 when rare extremes are the subject, such as a cyclone
  eye (`examples/surface-wind-chido-2024-12.json`).
- `bounds` (optional): regional crop `[west, south, east, north]`, read at
  native resolution with `factor: 1`.

Rendering validates decoded codes against the expected ones (p99 error budget)
before writing the manifest; `--upload` requires the bucket CORS rule to exist
and never rewrites it.

A catalog entry may list several GeoVideo sources, each with
`temporal.mode: "fixed"` and its `start`/`end`. With `source: "auto"`, zartigl
picks the GeoVideo covering the requested time or time range (the latest
period when several do), and falls back to Zarr otherwise. A regional artifact
is meant to be referenced explicitly by source id, as the story does for Chido.
Point queries always use Zarr.

`vector_lab.py` measures codec losses and exports the side-by-side browser lab
(`npm run dev:geovideo-vector`).

## Incremental archive

`archive.py` maintains GeoVideo for whole time windows as immutable,
calendar-aligned chunks plus one mutable index per archive source. It reuses
both renderers and their validation; nothing is published unless it passes.

```bash
npm run geovideo:plan                       # required, present, and pending chunks
npm run geovideo:run -- --budget 90m        # render, publish, and index pending chunks
npm run geovideo:run -- --source <uuid> --max-chunks 1
uv run scripts/geovideo/archive.py domain --source <uuid>   # suggest a vector valueDomain
npm run test:geovideo
```

Policies live in `archive.json`, keyed by an archive `sourceId`:

- `windows`: any of `{ "full": true }`, `{ "rolling": "P60D" }`, or
  `{ "start": …, "end": … }`. A window selects every calendar chunk it
  touches, and a chunk holds all source timestamps of its period up to now, so
  "ten days in March 2025" publishes March 2025. Forecast steps are excluded.
- `chunk`: optional; by default live sources use monthly chunks (a growing
  chunk is re-rendered at each new timestamp) and final historical data uses
  monthly (hourly), yearly (daily), or decade (monthly) chunks.
- `step` (`PTnH`/`PnD`, anchored to the epoch), `bounds`, `output`, and
  scalar `framesPerSample`. Scalar size defaults to the native grid within
  2048×1024. Vector archives pin `output.valueDomain` so particle speeds and
  colors stay continuous across chunks.
- `revisionHorizon`: defaults to `P10D` for non-historical sources. Chunks
  whose last sample is that recent carry a daily stamp and are re-rendered until
  they settle.

A chunk key hashes the encoding profile (store URL including the dataset
version, variables, color domain or vector settings, bounds, output) and the
exact timestamps. Palette and vibrance are excluded because the browser applies
them; zartigl takes the palette from catalog defaults. A key already in the
index is never rendered again; a changed key re-renders its period, which also
repairs drift after a catalog or upstream change.

Objects live under `geovideo/<entryId>/<sourceId>/<key>/` with
`geovideo/<entryId>/<sourceId>/index.json` beside them. Chunks are uploaded
before the index (short cache lifetime) is rewritten; a replaced chunk is
deleted one day later so cached indexes stay valid. Runs are round-robin
across archives, newest chunk first, and stop starting chunks when the budget
is spent; the next run resumes. A failing chunk pauses only its archive and
fails the run.

To serve an archive, add a GeoVideo source with `indexUrl` (and no
`manifestUrl`) to the catalog entry once its index exists. zartigl expands it
to one fixed-period source per chunk; times between or outside chunks, depths
below the surface, and point queries use Zarr. `validate_catalog.py` requires
every catalog `indexUrl` source to have an `archive.json` policy.

`.github/workflows/geovideo.yml` runs the archive daily and on demand on the
`[self-hosted, bigproc]` runner (ffmpeg with libx264, uv, Node). It needs the
`S3_KEY` and `S3_SECRET` repository secrets; endpoint and bucket come from
`.env.demo`.
