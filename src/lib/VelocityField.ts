import type { VelocityData } from "./types.js";
import { bindTexture } from "./gl-util.js";

/**
 * Manages a WebGL texture that holds stitched U/V velocity data
 * in geographic space [0,1]x[0,1], with R=u, G=v normalized to [0,1].
 */
export class VelocityField {
  private gl: WebGLRenderingContext | null = null;
  private texture: WebGLTexture | null = null;
  private width = 0;
  private height = 0;
  uMin = 0;
  uMax = 0;
  vMin = 0;
  vMax = 0;
  geoBounds = { west: -180, south: -90, east: 180, north: 90 };

  init(gl: WebGLRenderingContext): void {
    this.gl = gl;
  }

  /**
   * Upload velocity data as a 2-channel (RG) texture.
   * Input: u/v Float32Arrays with real physical values.
   * Stored normalized to [0,1] using uMin/uMax/vMin/vMax.
   */
  update(data: VelocityData): void {
    const gl = this.gl!;
    const { u, v, width, height, uMin, uMax, vMin, vMax } = data;

    this.width = width;
    this.height = height;
    this.uMin = uMin;
    this.uMax = uMax;
    this.vMin = vMin;
    this.vMax = vMax;
    this.geoBounds = data.bounds;

    const uRange = uMax - uMin || 1;
    const vRange = vMax - vMin || 1;

    // Encode to RGBA Uint8 (R=u, G=v, B=0, A=255)
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const uVal = u[i];
      const vVal = v[i];

      if (isNaN(uVal) || isNaN(vVal)) {
        // nodata → zero velocity (particles will be reseeded)
        pixels[i * 4] = 0;
        pixels[i * 4 + 1] = 0;
      } else {
        pixels[i * 4] = Math.round(
          (Math.max(0, Math.min(1, (uVal - uMin) / uRange))) * 255,
        );
        pixels[i * 4 + 1] = Math.round(
          (Math.max(0, Math.min(1, (vVal - vMin) / vRange))) * 255,
        );
      }
      pixels[i * 4 + 2] = 0;
      pixels[i * 4 + 3] = 255;
    }

    if (!this.texture) {
      this.texture = gl.createTexture();
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bind(unit: number): void {
    if (this.texture && this.gl) {
      bindTexture(this.gl, this.texture, unit);
    }
  }

  hasData(): boolean {
    return this.texture !== null && this.width > 0;
  }

  destroy(): void {
    if (this.gl && this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
  }
}

/**
 * Stitch multiple decoded chunks into a single global velocity grid.
 * The result covers [0,360) longitude x [-90,90] latitude.
 * Grid resolution matches the source data.
 */
export function stitchVelocityChunks(
  uChunks: Array<{
    data: Float32Array;
    latStart: number;
    lonStart: number;
    latSize: number;
    lonSize: number;
  }>,
  vChunks: Array<{
    data: Float32Array;
    latStart: number;
    lonStart: number;
    latSize: number;
    lonSize: number;
  }>,
  totalLat: number,
  totalLon: number,
  geoBounds?: { west: number; south: number; east: number; north: number },
): VelocityData {
  const u = new Float32Array(totalLat * totalLon).fill(NaN);
  const v = new Float32Array(totalLat * totalLon).fill(NaN);

  for (const chunk of uChunks) {
    for (let r = 0; r < chunk.latSize; r++) {
      for (let c = 0; c < chunk.lonSize; c++) {
        const srcIdx = r * chunk.lonSize + c;
        const dstIdx = (chunk.latStart + r) * totalLon + (chunk.lonStart + c);
        u[dstIdx] = chunk.data[srcIdx];
      }
    }
  }

  for (const chunk of vChunks) {
    for (let r = 0; r < chunk.latSize; r++) {
      for (let c = 0; c < chunk.lonSize; c++) {
        const srcIdx = r * chunk.lonSize + c;
        const dstIdx = (chunk.latStart + r) * totalLon + (chunk.lonStart + c);
        v[dstIdx] = chunk.data[srcIdx];
      }
    }
  }

  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity;
  for (let i = 0; i < u.length; i++) {
    if (!isNaN(u[i])) {
      if (u[i] < uMin) uMin = u[i];
      if (u[i] > uMax) uMax = u[i];
    }
    if (!isNaN(v[i])) {
      if (v[i] < vMin) vMin = v[i];
      if (v[i] > vMax) vMax = v[i];
    }
  }

  if (!isFinite(uMin)) uMin = -1;
  if (!isFinite(uMax)) uMax = 1;
  if (!isFinite(vMin)) vMin = -1;
  if (!isFinite(vMax)) vMax = 1;

  return {
    u,
    v,
    width: totalLon,
    height: totalLat,
    uMin,
    uMax,
    vMin,
    vMax,
    bounds: geoBounds ?? { west: -180, south: -90, east: 180, north: 90 },
  };
}
