import type { GeoVideoManifest, GeoVideoScalarEncoding } from "./geovideo";
import { GeoVideoFrameSource } from "./GeoVideoFrameSource";

/** One scalar-luma frame, as decoded by the browser; GPU input only. */
export type GeoVideoScalarFrame = ImageBitmap;

/** Uniforms of GEOVIDEO_SCALAR_GLSL for a scalar-luma encoding. */
export function geoVideoScalarUniforms(
  encoding: Pick<
    GeoVideoScalarEncoding,
    "codeMin" | "codeMax" | "valueMin" | "valueMax"
  > &
    Partial<Pick<GeoVideoScalarEncoding, "transfer">>,
): {
  codeRange: [number, number];
  valueRange: [number, number];
  /** `u_scalar_transfer`: 0 linear, 1 "log10-1p9". */
  transfer: number;
} {
  return {
    codeRange: [encoding.codeMin / 255, encoding.codeMax / 255],
    valueRange: [encoding.valueMin, encoding.valueMax],
    transfer: encoding.transfer === "log10-1p9" ? 1 : 0,
  };
}

/**
 * Scalar-luma GeoVideo read frame by frame (seek, no playback). Frames stay
 * images, uploaded as textures and decoded by GEOVIDEO_SCALAR_GLSL, the
 * decoder GeoVideoLayer uses: never read back, so both renderers turn the
 * same pixels into the same values.
 */
export class GeoVideoScalarSource extends GeoVideoFrameSource<GeoVideoScalarFrame> {
  constructor(
    manifest: GeoVideoManifest,
    options: { cacheSize?: number } = {},
  ) {
    if (manifest.encoding.kind !== "scalar-luma") {
      throw new Error("GeoVideoScalarSource requires a scalar-luma manifest");
    }
    super(manifest, 1, options);
  }

  protected async capture(
    video: HTMLVideoElement,
  ): Promise<GeoVideoScalarFrame | null> {
    if (this.isBlank(video)) {
      return null;
    }
    return createImageBitmap(video, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  }
}
