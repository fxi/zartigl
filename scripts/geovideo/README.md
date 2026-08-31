# GeoVideo renderer

GeoVideo turns a scalar catalog layer into an equirectangular, streamable MP4
plus a spatial/temporal JSON manifest. GeoVideo stores quantized values in H.264
luminance and keeps a static validity mask in a separate lossless PNG. The
browser applies palette and scalar styling in WebGL.

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
