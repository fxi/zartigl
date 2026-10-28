import {
  geoVideoScalarUniforms,
  type GeoVideoScalarFrame,
} from "./GeoVideoScalarSource";
import type { GeoVideoVectorFrame } from "./GeoVideoVectorSource";
import { createGeoVideoFrameSource } from "./GeoVideoArchiveSource";
import {
  geoVideoTimelineValues,
  type GeoVideoBounds,
  type GeoVideoManifest,
} from "./geovideo";
import { timeBracket } from "./time-bracket";

/** Texture and uniform binding supplied by the renderer. */
export interface GeoVideoProgram {
  texture(name: string, unit: number, texture: WebGLTexture): void;
  float(name: string, value: number): void;
  vec2(name: string, x: number, y: number): void;
  vec4(name: string, value: readonly number[]): void;
}

export interface GeoVideoFieldOptions {
  /** Repeat global grids in longitude; false for an inset MapLibre grid. */
  repeatLongitude?: boolean;
  /** Play the media frames of a single-date snapshot; times then follow its media cadence. */
  animateSnapshot?: boolean;
  onError?: (error: unknown) => void;
  /** A decoded step was uploaded; a paused renderer can redraw it. */
  onReady?: () => void;
}

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

/**
 * GeoVideo frames as textures, decoded ahead of the playhead: vector frames
 * as float (u, v, validity, 0), scalar frames as the browser decodes them,
 * turned into values in the shader by zartigl's GEOVIDEO_SCALAR_GLSL (with a
 * static mask texture), the decoder of its MapLibre layer. Binds two
 * consecutive time steps and their mix under VELOCITY_UNIFORMS for a vector
 * field, TINT_UNIFORMS for a scalar one.
 */
export class GeoVideoField {
  readonly times: number[];
  readonly bounds: GeoVideoBounds;
  /** Vector field (particles); false for a scalar one (raster or tint). */
  readonly vector: boolean;
  private readonly source: ReturnType<typeof createGeoVideoFrameSource>;
  private readonly uniforms: FieldUniforms;
  private readonly textures = new Map<number, WebGLTexture>();
  private readonly pending = new Map<number, Promise<void>>();
  /** Static validity of a scalar field, uploaded with its first frame. */
  private mask: WebGLTexture | null = null;
  private pair: [WebGLTexture, WebGLTexture, number] | null = null;
  private destroyed = false;
  private linearFilter = true;
  uploadedFrames = 0;
  lastUploadDurationMs = 0;

  get currentPair(): readonly [WebGLTexture, WebGLTexture, number] | null {
    return this.pair;
  }

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly manifest: GeoVideoManifest,
    private readonly options: GeoVideoFieldOptions = {},
  ) {
    this.vector = manifest.encoding.kind === "vector-luma";
    this.source = createGeoVideoFrameSource(manifest, { cacheSize: 2 });
    this.uniforms = this.vector ? VELOCITY_UNIFORMS : TINT_UNIFORMS;
    const times = geoVideoTimelineValues(manifest);
    this.times =
      options.animateSnapshot && manifest.timeline.kind === "snapshot-loop"
        ? Array.from(
            {
              length: Math.max(
                1,
                Math.round(manifest.media.durationSeconds * manifest.media.fps),
              ),
            },
            (_, index) => times[0] + (index * 1000) / manifest.media.fps,
          )
        : times;
    this.bounds = manifest.bounds;
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

  /**
   * Bracketing textures and their mix, retaining the last complete pair
   * while a requested frame decodes.
   */
  sample(
    ms: number,
    interpolate = true,
  ): readonly [WebGLTexture, WebGLTexture, number] | null {
    const { index, fraction } = timeBracket(this.times, ms);
    const next = Math.min(index + 1, this.times.length - 1);
    if ([...this.pending.keys()].some((i) => i < index || i > next + 1)) {
      this.source.cancelAll();
      this.pending.clear();
    }
    for (const i of [index, next, next + 1]) {
      if (i < this.times.length) {
        void this.request(i).catch(() => undefined);
      }
    }
    const a = this.textures.get(index);
    const b = this.textures.get(next);
    const mix = interpolate ? fraction : 0;
    if (a && (mix === 0 || b)) {
      this.pair = [a, mix === 0 ? a : b!, mix];
    }
    this.evict(index);
    return this.pair;
  }

  /** Switch spatial filtering without changing the decoded-step cache. */
  setFilter(linear: boolean): void {
    if (this.linearFilter === linear) {
      return;
    }
    this.linearFilter = linear;
    const gl = this.gl;
    const previous = gl.getParameter(
      gl.TEXTURE_BINDING_2D,
    ) as WebGLTexture | null;
    for (const texture of this.textures.values()) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        linear ? gl.LINEAR : gl.NEAREST,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        linear ? gl.LINEAR : gl.NEAREST,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, previous);
  }

  get maskTexture(): WebGLTexture | null {
    return this.mask;
  }

  get cachedFrames(): number {
    return this.textures.size;
  }

  bind(program: GeoVideoProgram, ms: number, unit = 0): boolean {
    if (!this.sample(ms) || !this.pair) {
      return false;
    }
    const names = this.uniforms;
    program.texture(names.a, unit, this.pair[0]);
    program.texture(names.b, unit + 1, this.pair[1]);
    program.float(names.mix, this.pair[2]);
    program.vec4(names.bounds, this.bounds);
    if (this.mask && this.manifest.encoding.kind === "scalar-luma") {
      const { codeRange, valueRange, transfer } = geoVideoScalarUniforms(
        this.manifest.encoding,
      );
      program.texture("u_tint_mask", unit + 2, this.mask);
      program.vec2("u_code_range", ...codeRange);
      program.vec2("u_value_range", ...valueRange);
      // Log-scaled archives store codes at log10(1 + 9t).
      program.float("u_scalar_transfer", transfer);
    }
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
    this.gl.deleteTexture(this.mask);
    this.mask = null;
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
        if (
          !this.destroyed &&
          this.pending.get(index) === job &&
          !this.textures.has(index)
        ) {
          const started = performance.now();
          this.textures.set(index, this.uploadPreservingState(frame));
          this.uploadedFrames++;
          this.lastUploadDurationMs = performance.now() - started;
          this.options.onReady?.();
        }
      })
      .catch((error: unknown) => {
        if (
          !this.destroyed &&
          this.pending.get(index) === job &&
          !(error instanceof Error && error.name === "AbortError")
        ) {
          this.options.onError?.(error);
        }
        throw error;
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

  private uploadPreservingState(
    frame: GeoVideoVectorFrame | GeoVideoScalarFrame,
  ): WebGLTexture {
    const gl = this.gl;
    const texture = gl.getParameter(
      gl.TEXTURE_BINDING_2D,
    ) as WebGLTexture | null;
    const unpack = [
      gl.UNPACK_FLIP_Y_WEBGL,
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
      gl.UNPACK_ALIGNMENT,
    ];
    const values = unpack.map((name) => gl.getParameter(name) as number);
    try {
      return this.upload(frame);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      unpack.forEach((name, i) => gl.pixelStorei(name, values[i]));
    }
  }

  private upload(
    frame: GeoVideoVectorFrame | GeoVideoScalarFrame,
  ): WebGLTexture {
    const gl = this.gl;
    const { width, height } = this.source;
    const texture = this.gridTexture();
    if (this.vector) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        width,
        height,
        0,
        gl.RGBA,
        gl.FLOAT,
        velocityTexels(frame as GeoVideoVectorFrame),
      );
    } else {
      // The decoded pixels as they are, like zartigl's GeoVideoLayer.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        frame as GeoVideoScalarFrame,
      );
      this.mask ??= this.uploadMask();
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  /** The source's mask, loaded with its first frame, as an R8 texture. */
  private uploadMask(): WebGLTexture | null {
    const mask = this.source.mask;
    if (!mask) {
      return null;
    }
    const gl = this.gl;
    const texture = this.gridTexture();
    if (this.options.repeatLongitude === false) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      this.source.width,
      this.source.height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      mask,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return texture;
  }

  /** A bound, linearly filtered texture over the field grid. */
  private gridTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // A regional grid must not blend its east edge into its west one.
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      this.options.repeatLongitude !== false &&
        this.bounds[2] - this.bounds[0] >= 359
        ? gl.REPEAT
        : gl.CLAMP_TO_EDGE,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      this.linearFilter ? gl.LINEAR : gl.NEAREST,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      this.linearFilter ? gl.LINEAR : gl.NEAREST,
    );
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
