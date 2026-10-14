import {
  GeoVideoScalarSource,
  GeoVideoVectorSource,
  geoVideoTimelineValues,
  type GeoVideoBounds,
  type GeoVideoFrameSource,
  type GeoVideoManifest,
  type GeoVideoVectorFrame,
} from "../engine";
import { isGlobalGrid, type Program } from "./view";

/** Shader uniforms a field binds: two time steps, their mix, the bounds. */
export interface FieldUniforms {
  a: string;
  b: string;
  mix: string;
  bounds: string;
}

/** shaders/velocity.glsl */
export const VELOCITY_UNIFORMS: FieldUniforms = {
  a: "u_vel0",
  b: "u_vel1",
  mix: "u_vel_mix",
  bounds: "u_bounds",
};

/** shaders/tint.glsl */
export const TINT_UNIFORMS: FieldUniforms = {
  a: "u_tint0",
  b: "u_tint1",
  mix: "u_tint_mix",
  bounds: "u_tint_bounds",
};

/** Masked scalar values as (value, validity) texels. */
export function scalarTexels(values: Float32Array): Float32Array {
  const texels = new Float32Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isNaN(value)) {
      texels[i * 2] = value;
      texels[i * 2 + 1] = 1;
    }
  }
  return texels;
}

/** Interleaves masked u/v planes into (u, v, validity, 0) texels. */
export function velocityTexels(frame: GeoVideoVectorFrame): Float32Array {
  const texels = new Float32Array(frame.u.length * 4);
  for (let i = 0; i < frame.u.length; i++) {
    const u = frame.u[i];
    const v = frame.v[i];
    if (Number.isNaN(u) || Number.isNaN(v)) {
      continue;
    }
    texels[i * 4] = u;
    texels[i * 4 + 1] = v;
    texels[i * 4 + 2] = 1;
  }
  return texels;
}

/** Index of the step at or before `ms` and the fraction toward the next. */
export function timeBracket(
  times: readonly number[],
  ms: number,
): { index: number; fraction: number } {
  if (ms <= times[0]) {
    return { index: 0, fraction: 0 };
  }
  const last = times.length - 1;
  if (ms >= times[last]) {
    return { index: last, fraction: 0 };
  }
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { index: lo, fraction: (ms - times[lo]) / (times[hi] - times[lo]) };
}

/**
 * GeoVideo frames as float textures, decoded ahead of the playhead: vector
 * frames as (u, v, validity, 0), scalar frames as (value, validity). Binds
 * two consecutive time steps and their mix under VELOCITY_UNIFORMS for a
 * vector field, TINT_UNIFORMS for a scalar one.
 */
export class GeoVideoField {
  readonly times: number[];
  readonly bounds: GeoVideoBounds;
  private readonly source: GeoVideoFrameSource<unknown>;
  private readonly texels: (frame: unknown) => Float32Array;
  /** 4 for vector texels, 2 for scalar ones. */
  private readonly channels: number;
  private readonly uniforms: FieldUniforms;
  private readonly textures = new Map<number, WebGLTexture>();
  private readonly pending = new Map<number, Promise<void>>();
  private pair: [WebGLTexture, WebGLTexture, number] | null = null;
  private destroyed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly manifest: GeoVideoManifest,
  ) {
    if (manifest.encoding.kind === "vector-luma") {
      this.source = new GeoVideoVectorSource(manifest, { cacheSize: 2 });
      this.texels = (frame) => velocityTexels(frame as GeoVideoVectorFrame);
      this.channels = 4;
      this.uniforms = VELOCITY_UNIFORMS;
    } else {
      this.source = new GeoVideoScalarSource(manifest, { cacheSize: 2 });
      this.texels = (frame) => scalarTexels(frame as Float32Array);
      this.channels = 2;
      this.uniforms = TINT_UNIFORMS;
    }
    this.times = geoVideoTimelineValues(manifest);
    this.bounds = manifest.bounds;
  }

  /** Vector field (particles); false for a scalar one (raster or tint). */
  get vector(): boolean {
    return this.channels === 4;
  }

  /** Fixed catalog color domain of a scalar field. */
  get domain(): [number, number] {
    return this.manifest.style.colorDomain;
  }

  /** Top of the color ramp and of the particle speed normalization. */
  get maxSpeed(): number {
    const { encoding, style } = this.manifest;
    return encoding.kind === "vector-luma"
      ? encoding.valueDomain
      : style.colorDomain[1];
  }

  /** Resolves once the step at `ms` is uploaded. */
  async prime(ms: number): Promise<void> {
    const { index } = timeBracket(this.times, ms);
    await this.request(index);
  }

  /** True once the frames interpolated at `ms` are uploaded. */
  ready(ms: number): boolean {
    const { index, fraction } = timeBracket(this.times, ms);
    return (
      this.textures.has(index) &&
      (fraction === 0 || this.textures.has(index + 1))
    );
  }

  /**
   * Latest wins while scrubbing: drop queued decodes outside the frames at
   * `ms`, then request those first.
   */
  focus(ms: number): void {
    const { index } = timeBracket(this.times, ms);
    const next = Math.min(index + 1, this.times.length - 1);
    const stale = [...this.pending.keys()].some(
      (i) => i !== index && i !== next,
    );
    if (stale) {
      this.source.cancelAll();
      this.pending.clear();
    }
    for (const i of [index, next]) {
      void this.request(i).catch(() => undefined);
    }
  }

  /** False until a first frame is available. */
  bind(program: Program, ms: number, unit = 0): boolean {
    const { index, fraction } = timeBracket(this.times, ms);
    const next = Math.min(index + 1, this.times.length - 1);
    for (const i of [index, next, next + 1]) {
      if (i < this.times.length) {
        void this.request(i).catch(() => undefined);
      }
    }
    this.evict(index);
    const a = this.textures.get(index);
    const b = this.textures.get(next);
    if (a) {
      this.pair = [a, b ?? a, b ? fraction : 0];
    }
    if (!this.pair) {
      return false;
    }
    const names = this.uniforms;
    program.texture(names.a, unit, this.pair[0]);
    program.texture(names.b, unit + 1, this.pair[1]);
    program.float(names.mix, this.pair[2]);
    program.vec4(names.bounds, this.bounds);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.source.cancelAll();
    this.source.release();
    for (const texture of this.textures.values()) {
      this.gl.deleteTexture(texture);
    }
    this.textures.clear();
    this.pair = null;
  }

  private request(index: number): Promise<void> {
    if (this.textures.has(index)) {
      return Promise.resolve();
    }
    const pending = this.pending.get(index);
    if (pending) {
      return pending;
    }
    const job = this.source
      .frame(index)
      .then((frame) => {
        if (!this.destroyed && !this.textures.has(index)) {
          this.textures.set(index, this.upload(frame));
        }
      })
      .finally(() => {
        // A cancelled request can settle after the one that replaced it.
        if (this.pending.get(index) === job) {
          this.pending.delete(index);
        }
      });
    this.pending.set(index, job);
    return job;
  }

  private upload(frame: unknown): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // A regional grid must not blend its east edge into its west one.
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      isGlobalGrid(this.bounds) ? gl.REPEAT : gl.CLAMP_TO_EDGE,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const vector = this.channels === 4;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      vector ? gl.RGBA16F : gl.RG16F,
      this.source.width,
      this.source.height,
      0,
      vector ? gl.RGBA : gl.RG,
      gl.FLOAT,
      this.texels(frame),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  /** Keep a small window around the playhead. */
  private evict(index: number): void {
    for (const [i, texture] of this.textures) {
      const inPair =
        this.pair && (this.pair[0] === texture || this.pair[1] === texture);
      if ((i < index - 1 || i > index + 3) && !inPair) {
        this.gl.deleteTexture(texture);
        this.textures.delete(i);
      }
    }
  }
}
