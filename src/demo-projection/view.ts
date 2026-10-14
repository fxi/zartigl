import { createProgram } from "../engine";
import {
  blendClipAngle,
  rotationMatrix,
  transpose,
  type Blend,
  type Mat3,
} from "./projections";

/** Everything that places the sphere on screen. */
export interface View {
  blend: Blend;
  /** d3 rotate([λ, φ, γ]) in degrees. */
  rotate: [number, number, number];
  zoom: number;
  /** Css px. */
  width: number;
  height: number;
}

/** Values derived once per frame from a View, shared by every pass. */
export interface ViewFrame extends View {
  /** Clip angle in degrees; 180 = antimeridian cut only. */
  clipAngle: number;
  /** Geographic → rotated frame, and its inverse. */
  rot: Mat3;
  rotInv: Mat3;
  /** Approximate px per radian at the projection center. */
  pxPerRadian: number;
}

export function viewFrame(view: View): ViewFrame {
  const rot = rotationMatrix(view.rotate);
  const { ka, kb, t } = view.blend;
  return {
    ...view,
    clipAngle: blendClipAngle(view.blend),
    rot,
    rotInv: transpose(rot),
    pxPerRadian: view.zoom * ((1 - t) * ka + t * kb),
  };
}

/**
 * Whether a west, south, east, north grid spans every longitude, so it
 * repeats across the antimeridian (shaders/grid.glsl onGrid uses the same
 * threshold).
 */
export function isGlobalGrid(
  bounds: readonly [number, number, number, number],
): boolean {
  return bounds[2] - bounds[0] >= 359;
}

/** Share of the smaller viewport side a framed region spans. */
const REGION_FILL = 0.85;

/**
 * Rotation and zoom that center a regional grid (west, south, east, north)
 * on the current projection; null for a global one.
 */
export function regionView(
  bounds: readonly [number, number, number, number],
  view: View,
): { rotate: [number, number, number]; zoom: number } | null {
  const [west, south, east, north] = bounds;
  if (isGlobalGrid(bounds)) {
    return null;
  }
  const lon = (west + east) / 2;
  const lat = (south + north) / 2;
  const span =
    (Math.max((east - west) * Math.cos((lat * Math.PI) / 180), north - south) *
      Math.PI) /
    180;
  const { ka, kb, t } = view.blend;
  const scale = (1 - t) * ka + t * kb;
  return {
    rotate: [-lon, -lat, 0],
    zoom: (REGION_FILL * Math.min(view.width, view.height)) / (span * scale),
  };
}

/** WebGL2 program with cached uniform locations. */
export class Program {
  readonly program: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    readonly gl: WebGL2RenderingContext,
    vert: string,
    frag: string,
  ) {
    this.program = createProgram(gl, vert, frag);
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.locations.get(name) ?? null;
  }

  int(name: string, v: number): void {
    this.gl.uniform1i(this.loc(name), v);
  }

  uint(name: string, v: number): void {
    this.gl.uniform1ui(this.loc(name), v);
  }

  float(name: string, v: number): void {
    this.gl.uniform1f(this.loc(name), v);
  }

  vec2(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.loc(name), x, y);
  }

  vec4(name: string, v: readonly number[]): void {
    this.gl.uniform4f(this.loc(name), v[0], v[1], v[2], v[3]);
  }

  mat3(name: string, m: Mat3): void {
    this.gl.uniformMatrix3fv(this.loc(name), false, m);
  }

  texture(
    name: string,
    unit: number,
    texture: WebGLTexture,
    target?: number,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target ?? gl.TEXTURE_2D, texture);
    this.int(name, unit);
  }

  /** Uniforms of shaders/project.glsl. */
  projection(frame: ViewFrame): void {
    const { blend } = frame;
    this.int("u_proj_a", blend.a.glslId);
    this.int("u_proj_b", blend.b.glslId);
    this.float("u_ka", blend.ka);
    this.float("u_kb", blend.kb);
    this.float("u_t", blend.t);
    this.float("u_zoom", frame.zoom);
    this.vec2("u_center", frame.width / 2, frame.height / 2);
    this.vec2("u_viewport", frame.width, frame.height);
    this.float(
      "u_clip",
      frame.clipAngle >= 180 ? 2 * Math.PI : (frame.clipAngle * Math.PI) / 180,
    );
  }

  delete(): void {
    this.gl.deleteProgram(this.program);
  }
}
