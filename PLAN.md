# Scalar-encoded GeoVideo exploration

## Goal

Evaluate whether a browser-decodable video can transport quantized scalar raster
values instead of pre-styled RGB frames. If the round trip is stable enough, the
client can apply the palette, color domain, opacity, vibrance, logarithmic scale,
and validity mask in the shader while retaining the bandwidth and playback
benefits of GeoVideo.

This representation is intended for visualization. Zarr remains the source for
scientific analysis and exact values.

The same transport can carry vector fields by packing two grayscale components
side by side (`u | v`). The stabilized canvas-buffer path already used by
GeoVideo can crop those halves into independent GPU textures.

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
- For vector fields, encode `u` and `v` independently rather than direction and
  magnitude; this avoids the angular discontinuity at 0/360 degrees.
- Prefer a static lossless mask image when validity is time-invariant. Before
  encoding, fill masked pixels from nearby valid values to prevent H.264 ringing
  at coastlines; the mask remains the authority for visibility.

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

## Preliminary FFmpeg results

`scripts/geovideo/calibrate.py` now exercises scalar 2048x1024 and packed vector
4096x1024 videos with deterministic ramps, moving gradients, hard `nodata`
edges, and an adversarial noise field.

With H.264 `yuv420p`, CRF 12, and a 16 Mbit/s ceiling:

- the stable scalar ramp retains 206 distinct valid modal codes;
- the RGB/YUV round trip produces a deterministic mean code offset of about
  1.73 and a maximum of 2 even at CRF 0, so a decode LUT or calibrated transfer
  is required;
- the moving-gradient region has a p99 code error of 3; its larger isolated
  errors occur at the deliberately wrapped 255-to-0 discontinuity;
- stable and moving vector regions have vector RMSE around 0.042-0.044 over a
  component range of -2 to 2; mean direction error for the moving field is about
  0.54 degrees when speeds below 0.2 are excluded;
- the incompressible noise stress field degrades substantially, as expected;
- encoding `nodata` beside valid values is unsafe with the initial `0..7` guard
  band. A separate static mask plus filled invalid pixels is the preferred path.

These are codec-only measurements. They validate continued exploration but do
not yet satisfy the browser acceptance criteria below.

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
6. For vector data, compare reconstructed vectors and particle trajectories with
   the equivalent Zarr field over several hundred simulation steps.

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
- Vector RMSE, speed bias, angular error away from zero speed, and accumulated
  particle-trajectory divergence remain within an explicitly reported budget.
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
