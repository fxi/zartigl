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
