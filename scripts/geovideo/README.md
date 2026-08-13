# GeoVideo renderer

GeoVideo turns a scalar catalog layer into an equirectangular, streamable MP4
plus a spatial/temporal JSON manifest. RGB occupies the left half of every
encoded frame and the validity alpha mask occupies the right half.

```bash
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json --dry-run
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json --upload
uv run scripts/geovideo/render.py scripts/geovideo/examples/sst-anomaly.json --upload-only
```

`ffmpeg` must be available in `PATH`. Upload reads S3 credentials from `.env`;
credentials are never written to the artifact. Public endpoint and bucket
defaults come from `.env.demo`. Override `upload.publicBaseUrl` for a CDN or a
virtual-hosted bucket URL.

For a cheap end-to-end check, copy the example, lower its resolution/duration,
and pass `--max-frames 2`. `--max-frames` is intentionally a smoke-test option:
the resulting shortened media retains the requested timeline in its manifest
and must not be published as a production artifact.

## Scalar and vector calibration

`calibrate.py` generates deterministic scalar and packed `u | v` value videos,
round-trips them through the production H.264 settings, and reports code,
`nodata`, speed, and direction errors:

```bash
npm run geovideo:calibrate
```

Outputs are written below `artifacts/geovideo-calibration/` and are ignored by
Git. These statistics cover FFmpeg decoding; browser canvas/WebGL calibration is
still required before adopting scalar-encoded video as a public format.

Use `--crf`, `--max-bitrate`, `--frames`, `--width`, and `--height` to compare
profiles. The defaults exercise the current production dimensions and codec
settings; for example:

```bash
uv run scripts/geovideo/calibrate.py --frames 12 --crf 12 --max-bitrate 16M
```
