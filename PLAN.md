# Scalar-encoded GeoVideo exploration

## Goal

Evaluate whether a browser-decodable video can transport quantized scalar raster
values instead of pre-styled RGB frames. If the round trip is stable enough, the
client can apply the palette, color domain, opacity, vibrance, logarithmic scale,
and validity mask in the shader while retaining the bandwidth and playback
benefits of GeoVideo.

This representation is intended for scalar visualization only. Zarr remains the
source for point clicks, scientific analysis, and exact values. Vector animation
already uses spatial/temporal Zarr chunks and is outside this work.

## Proposed encoding

- Normalize the configured physical range into reserved 8-bit luminance codes.
- Reserve guard bands and encode valid values in codes `8..247`. Validity does
  not depend on these codes; the separate lossless mask is authoritative.
- Write each code as neutral grayscale (`R = G = B`) so useful information stays
  in the full-resolution luma plane of H.264 `yuv420p`.
- Keep the geographic bounds, timeline, physical range, transfer function, code
  range, mask URL, color space, and default style in the manifest.
- Decode the sampled luminance in the fragment shader and apply the existing
  scalar styling path. Do not expose decoded values as exact scientific samples.
- Prefer a static lossless mask image when validity is time-invariant. Before
  encoding, fill masked pixels from nearby valid values to prevent H.264 ringing
  at coastlines; the mask remains the authority for visibility.
- If source validity varies, derive the static mask from the intersection across
  all frames. Conservatively hide those varying pixels and record their count in
  the artifact report.

Candidate manifest metadata:

```json
{
  "encoding": {
    "kind": "scalar-luma",
    "bits": 8,
    "codeMin": 8,
    "codeMax": 247,
    "valueMin": -3,
    "valueMax": 3,
    "transfer": "linear",
    "colorSpace": "bt709",
    "colorRange": "limited"
  }
}
```

This is implemented as GeoVideo manifest schema v2. Schema v1 remains readable.

## Preliminary FFmpeg results

`scripts/geovideo/calibrate.py` exercises scalar videos with deterministic ramps,
moving gradients, hard `nodata` edges, and an adversarial noise field.

With H.264 `yuv420p`, CRF 12, and a 16 Mbit/s ceiling:

- the stable scalar ramp retains 206 distinct valid modal codes;
- the RGB/YUV round trip produces a small deterministic code offset;
- the moving-gradient region has a p99 code error of 3; its larger isolated
  errors occur at the deliberately wrapped 255-to-0 discontinuity;
- the incompressible noise stress field degrades substantially, as expected;
- encoding `nodata` beside valid values is unsafe with the initial `0..7` guard
  band. A separate static mask plus filled invalid pixels is the preferred path.

Chrome's video → canvas → WebGL readback retains 212 stable ramp codes, with a
maximum ramp error of one code and no temporal variation over the tested clip.
Safari and Firefox remain publication gates.

A two-frame 2048×1024 Copernicus SST anomaly extraction encoded with the
production CRF 12 / 16 Mbit/s profile occupies 482 KiB. On sampled valid pixels,
its mean absolute error is 2.01 codes, p99 is 6, and maximum is 10 (about 0.15 °C
at p99 over the configured six-degree visualization range). Artifact generation
and `--upload-only` enforce a field budget of p99 ≤ 8 and maximum ≤ 16 codes.

## Calibration prototype

1. Generate a short local test video containing all 256 codes, smooth gradients,
   sharp boundaries, `nodata` edges, and representative SST frames.
2. Encode it with the same H.264 profile, pixel format, bitrate constraints, GOP,
   dimensions, and frame rate used by the GeoVideo renderer.
3. Decode every presented frame through the production browser path: video,
   canvas snapshot, WebGL texture, and shader/readback. Test Chrome first, then
   Safari and Firefox where available.
4. Record per code and per frame:
   - decoded minimum, maximum, mean, bias, and absolute error;
   - temporal variation of otherwise constant pixels;
   - spatial errors at gradients and discontinuities;
   - decoded, buffered, skipped, uploaded, and browser-dropped frame counts.
5. Compare direct video playback with MapLibre globe and Mercator playback.

Do not introduce browser-specific correction logic.

## Acceptance criteria

- The lossless mask is exact and no masked pixel leaks into the rendered field.
- At least 128 reliably distinguishable scalar levels remain after round trip.
- Stable-ramp error stays within two encoded codes through canvas and WebGL.
- Constant encoded pixels do not flicker between palette bins during playback.
- Playback remains as smooth as the current buffered RGB GeoVideo implementation.
- The scalar video is materially smaller or more flexible than equivalent
  pre-styled renditions; otherwise retain the current RGB approach.

## Follow-up if successful

- Add scalar-luma as a new media encoding supported alongside the current
  pre-styled GeoVideo representation.
- Reuse the scalar layer's palette texture and style controls in the GeoVideo
  shader, with catalog style values as defaults rather than baked colors.
- Add generator round-trip validation and reject artifacts that fail their error
  budget before upload.
- Publish a new immutable SST artifact and switch the catalog only after browser
  validation. Keep existing S3 artifacts available for rollback.

## Stop conditions

Do not pursue scalar video further if browser color conversion is inconsistent,
if reliable levels fall below the acceptance threshold, or if decoding requires
browser-specific correction. In that case, retain the current buffered RGB
video. Do not expand this work into other formats or vector transports.
