import type { GeoVideoManifest, GeoVideoScalarEncoding } from "./geovideo";
import { GeoVideoFrameSource } from "./GeoVideoFrameSource";

/** Code to physical value, inverse of the linear scalar-luma quantization. */
export function decodeScalarValue(
  code: number,
  encoding: Pick<
    GeoVideoScalarEncoding,
    "codeMin" | "codeMax" | "valueMin" | "valueMax"
  >,
): number {
  const s = Math.max(
    0,
    Math.min(
      1,
      (code - encoding.codeMin) / (encoding.codeMax - encoding.codeMin),
    ),
  );
  return encoding.valueMin + s * (encoding.valueMax - encoding.valueMin);
}

/**
 * Luma codes to a value plane, NaN where the static mask is invalid.
 * `mask` holds one 8-bit validity value per grid cell.
 */
export function decodeScalarFrame(
  codes: Uint8Array,
  mask: Uint8Array,
  threshold: number,
  encoding: Pick<
    GeoVideoScalarEncoding,
    "codeMin" | "codeMax" | "valueMin" | "valueMax"
  >,
): Float32Array {
  const n = mask.length;
  if (codes.length !== n) {
    throw new Error(
      `GeoVideo scalar frame has ${codes.length} codes, expected ${n}`,
    );
  }
  const lut = new Float32Array(256);
  for (let code = 0; code < 256; code++) {
    lut[code] = decodeScalarValue(code, encoding);
  }
  const limit = threshold * 255;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    values[i] = mask[i] >= limit ? lut[codes[i]] : NaN;
  }
  return values;
}

/**
 * Scalar-luma GeoVideo read frame by frame (seek, no playback), for values
 * sampled on the GPU rather than the styled playback of GeoVideoLayer.
 */
export class GeoVideoScalarSource extends GeoVideoFrameSource<Float32Array> {
  private readonly encoding: GeoVideoScalarEncoding;

  constructor(
    manifest: GeoVideoManifest,
    options: { cacheSize?: number } = {},
  ) {
    if (manifest.encoding.kind !== "scalar-luma") {
      throw new Error("GeoVideoScalarSource requires a scalar-luma manifest");
    }
    super(manifest, 1, options);
    this.encoding = manifest.encoding;
  }

  protected decodeCodes(
    codes: Uint8Array,
    mask: Uint8Array,
    threshold: number,
  ): Float32Array {
    return decodeScalarFrame(codes, mask, threshold, this.encoding);
  }
}
