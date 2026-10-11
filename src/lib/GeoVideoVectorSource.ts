import type { GeoVideoManifest, GeoVideoVectorEncoding } from "./geovideo";
import { GeoVideoFrameSource } from "./GeoVideoFrameSource";
import type { VectorFieldSource, ZarrChunkFetchResult } from "./types";

export { isBlankReadback, lumaCodesFromRgba } from "./GeoVideoFrameSource";

/** Decoded u/v planes of one frame, NaN where the static mask is invalid. */
export interface GeoVideoVectorFrame {
  u: Float32Array;
  v: Float32Array;
}

/** Code to physical component value, inverse of the renderer quantization. */
export function decodeVectorComponent(
  code: number,
  encoding: Pick<
    GeoVideoVectorEncoding,
    "codeMin" | "codeMax" | "valueDomain" | "transfer"
  >,
): number {
  let s =
    ((code - encoding.codeMin) / (encoding.codeMax - encoding.codeMin)) * 2 - 1;
  s = Math.max(-1, Math.min(1, s));
  if (encoding.transfer === "sqrt") {
    s = Math.sign(s) * s * s;
  }
  return s * encoding.valueDomain;
}

/**
 * Stacked u/v codes (u rows first) to masked component planes.
 * `mask` holds one 8-bit validity value per grid cell.
 */
export function decodeVectorFrame(
  codes: Uint8Array,
  mask: Uint8Array,
  threshold: number,
  encoding: Pick<
    GeoVideoVectorEncoding,
    "codeMin" | "codeMax" | "valueDomain" | "transfer"
  >,
): GeoVideoVectorFrame {
  const n = mask.length;
  if (codes.length !== 2 * n) {
    throw new Error(
      `GeoVideo vector frame has ${codes.length} codes, expected ${2 * n}`,
    );
  }
  const lut = new Float32Array(256);
  for (let code = 0; code < 256; code++) {
    lut[code] = decodeVectorComponent(code, encoding);
  }
  const limit = threshold * 255;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const valid = mask[i] >= limit;
    u[i] = valid ? lut[codes[i]] : NaN;
    v[i] = valid ? lut[codes[n + i]] : NaN;
  }
  return { u, v };
}

/**
 * VectorLayer field source backed by a vector-luma GeoVideo: each time step is
 * one video frame, decoded on demand (frame by frame, no playback) into a
 * single chunk covering the whole grid.
 */
export class GeoVideoVectorSource
  extends GeoVideoFrameSource<GeoVideoVectorFrame>
  implements VectorFieldSource
{
  private readonly encoding: GeoVideoVectorEncoding;
  private readonly coords: {
    time: Float64Array;
    vertical: Float32Array;
    latitude: Float32Array;
    longitude: Float32Array;
  };

  constructor(
    manifest: GeoVideoManifest,
    options: { cacheSize?: number } = {},
  ) {
    if (manifest.encoding.kind !== "vector-luma") {
      throw new Error("GeoVideoVectorSource requires a vector-luma manifest");
    }
    // u rows above v rows.
    super(manifest, 2, options);
    this.encoding = manifest.encoding;
    const [west, south, east, north] = manifest.bounds;
    const dx = (east - west) / this.width;
    const dy = (north - south) / this.height;
    this.coords = {
      time: this.times,
      vertical: new Float32Array([0]),
      latitude: Float32Array.from(
        { length: this.height },
        (_, i) => north - (i + 0.5) * dy,
      ),
      longitude: Float32Array.from(
        { length: this.width },
        (_, i) => west + (i + 0.5) * dx,
      ),
    };
  }

  getValueDomain(): number {
    return this.encoding.valueDomain;
  }

  getCoords(): {
    time: Float64Array;
    vertical: Float32Array;
    latitude: Float32Array;
    longitude: Float32Array;
  } {
    return this.coords;
  }

  getDimensions(): string[] {
    return ["time", "latitude", "longitude"];
  }

  getChunkShape(): number[] {
    return [1, this.height, this.width];
  }

  findDepthIndex(): number {
    return 0;
  }

  findTimeIndex(time: string | number): number {
    const ms = typeof time === "number" ? time : new Date(time).getTime();
    const values = this.coords.time;
    let best = 0;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i] - ms) < Math.abs(values[best] - ms)) {
        best = i;
      }
    }
    return best;
  }

  getChunksForBounds(
    _variable: string,
    timeIdx: number,
    depthIdx: number,
  ): Array<{
    timeIdx: number;
    depthIdx: number;
    latIdx: number;
    lonIdx: number;
    latRange: [number, number];
    lonRange: [number, number];
    latSize: number;
    lonSize: number;
  }> {
    const { latitude, longitude } = this.coords;
    return [
      {
        timeIdx,
        depthIdx,
        latIdx: 0,
        lonIdx: 0,
        latRange: [latitude[0], latitude[this.height - 1]],
        lonRange: [longitude[0], longitude[this.width - 1]],
        latSize: this.height,
        lonSize: this.width,
      },
    ];
  }

  async fetchSpatialChunkResult(
    variable: string,
    selection: { timeIndex: number },
  ): Promise<ZarrChunkFetchResult> {
    const frame = await this.frame(selection.timeIndex);
    return {
      data: variable === "v" ? frame.v : frame.u,
      missing: false,
      url: this.manifest.media.url,
    };
  }

  protected decodeCodes(
    codes: Uint8Array,
    mask: Uint8Array,
    threshold: number,
  ): GeoVideoVectorFrame {
    return decodeVectorFrame(codes, mask, threshold, this.encoding);
  }
}
