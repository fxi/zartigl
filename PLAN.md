# Scalar-encoded GeoVideo exploration

## Goal

Evaluate whether a browser-decodable video can transport quantized scalar raster
values instead of pre-styled RGB frames. If the round trip is stable enough, the
client can apply the palette, color domain, opacity, vibrance, logarithmic scale,
and validity mask in the shader while retaining the bandwidth and playback
benefits of GeoVideo.

This representation is intended for visualization. Zarr remains the source for
scientific analysis and exact values.

## Proposed encoding

- Normalize the configured physical range into reserved 8-bit luminance codes.
- Reserve a low band for `nodata` and a high band for future metadata or guards;
  start by testing codes `8..247` for valid values and `0..7` for `nodata`.
- Write each code as neutral grayscale (`R = G = B`) so useful information stays
  in the full-resolution luma plane of H.264 `yuv420p`.
- Keep the geographic bounds, timeline, physical range, transfer function, code
  range, `nodata` range, color space, and default style in the manifest.
- Decode the sampled luminance in the fragment shader and apply the existing
  scalar styling path. Do not expose decoded values as exact scientific samples.

Candidate manifest metadata:

```json
{
  "encoding": {
    "kind": "scalar-luma",
    "bits": 8,
    "codeMin": 8,
    "codeMax": 247,
    "nodataMaxCode": 7,
    "valueMin": -3,
    "valueMax": 3,
    "transfer": "linear",
    "colorSpace": "bt709",
    "colorRange": "limited"
  }
}
```

The final wire shape must be based on the calibration results rather than added
to the public manifest immediately.

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
   - code confusion near `nodata`;
   - temporal variation of otherwise constant pixels;
   - spatial errors at gradients and discontinuities;
   - decoded, buffered, skipped, uploaded, and browser-dropped frame counts.
5. Compare direct video playback with MapLibre globe and Mercator playback.

Use a calibration lookup table only if it is stable across frames and browsers.
Prefer wider reserved guard bands over browser-specific correction logic.

## Acceptance criteria

- No valid sample is classified as `nodata`, and no `nodata` sample is classified
  as valid, across the tested browsers and the complete calibration clip.
- At least 200 reliably distinguishable scalar levels remain after round trip.
- The decoded physical error is below half of one retained quantization step for
  at least 99.9% of valid pixels; the remaining error must stay below one step.
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
if reliable levels fall below the acceptance threshold, or if preventing
`nodata` confusion requires a browser-specific decoder. In that case, retain the
current buffered RGB video and evolve transparency separately through a static
mask image or a calibrated color key.
