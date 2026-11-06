/**
 * The cube in WebGL2: one raymarch pass over the box's front faces (slices,
 * isotherm and its depth contours), then lines on top: box edges (hidden ones dashed),
 * slice outlines, the ROI box, coastlines on the surface and axis ticks.
 */

import type { Volume } from "../data/blocks";
import type { Frame, Vec3 } from "./camera";
import linesFrag from "./shaders/lines.frag.glsl";
import linesVert from "./shaders/lines.vert.glsl";
import volumeFrag from "./shaders/volume.frag.glsl";
import volumeVert from "./shaders/volume.vert.glsl";

export interface Show {
  slices: boolean;
  iso: boolean;
  roi: boolean;
  coast: boolean;
  /** Depth contours on the isotherm, with the 2D isotherms. */
  contours: boolean;
}

export interface RenderState {
  /** World x, y, z of the slice planes. */
  slice: Vec3;
  show: Show;
  /** Blend of the next month, 0–1. */
  mix: number;
  domain: [number, number];
  iso: number;
  /** Depth of the box bottom, metres. */
  bottom: number;
  /** Raymarch step, world units: larger on small screens. */
  step: number;
}

type GL = WebGL2RenderingContext;

function compile(gl: GL, vert: string, frag: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vert],
    [gl.FRAGMENT_SHADER, frag],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

class Uniforms {
  private cache = new Map<string, WebGLUniformLocation | null>();
  constructor(
    private gl: GL,
    private program: WebGLProgram,
  ) {}
  get(name: string): WebGLUniformLocation | null {
    if (!this.cache.has(name)) {
      this.cache.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.cache.get(name)!;
  }
}

/** Unit cube faces, outward and counter-clockwise, as triangles. */
const FACES: Array<{ normal: Vec3; corners: Vec3[] }> = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [-1, 1, -1],
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [1, 1, -1],
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
      [-1, -1, -1],
    ],
  },
];

function cubeTriangles(): Float32Array {
  const out: number[] = [];
  for (const { corners } of FACES) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      out.push(...corners[i]);
    }
  }
  return new Float32Array(out);
}

/** The 12 box edges as unit corners, with the two faces each one borders. */
const EDGES: Array<{ a: Vec3; b: Vec3; faces: [Vec3, Vec3] }> = (() => {
  const edges: Array<{ a: Vec3; b: Vec3; faces: [Vec3, Vec3] }> = [];
  for (let axis = 0; axis < 3; axis++) {
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const a: Vec3 = [0, 0, 0];
        a[axis] = -1;
        a[u] = su;
        a[v] = sv;
        const b: Vec3 = [...a];
        b[axis] = 1;
        const fu: Vec3 = [0, 0, 0];
        fu[u] = su;
        const fv: Vec3 = [0, 0, 0];
        fv[v] = sv;
        edges.push({ a, b, faces: [fu, fv] });
      }
    }
  }
  return edges;
})();

/** Interleaved (x, y, z, distance) vertices of line segments. */
export class LineBatch {
  data: number[] = [];

  segment(a: readonly number[], b: readonly number[]): this {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.data.push(a[0], a[1], a[2], 0, b[0], b[1], b[2], length);
    return this;
  }

  polyline(points: ReadonlyArray<readonly number[]>): this {
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      this.data.push(
        a[0],
        a[1],
        a[2],
        distance,
        b[0],
        b[1],
        b[2],
        distance + length,
      );
      distance += length;
    }
    return this;
  }

  /** The 12 edges of an axis-aligned box. */
  box(min: Vec3, max: Vec3): this {
    for (const { a, b } of EDGES) {
      const at = (c: Vec3) => c.map((s, i) => (s < 0 ? min[i] : max[i]));
      this.segment(at(a), at(b));
    }
    return this;
  }
}

interface Lines {
  buffer: WebGLBuffer;
  count: number;
}

export class CubeRenderer {
  readonly gl: GL;
  private volumeProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private volumeUniforms: Uniforms;
  private lineUniforms: Uniforms;
  private cube: WebGLBuffer;
  private volumes: [WebGLTexture, WebGLTexture];
  private lut: WebGLTexture;
  private steps = 1;
  private lines = new Map<string, Lines>();
  private edges: WebGLBuffer;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private half: Vec3,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      premultipliedAlpha: true,
      alpha: false,
    });
    if (!gl) {
      throw new Error("WebGL2 is not available");
    }
    this.gl = gl;
    this.volumeProgram = compile(gl, volumeVert, volumeFrag);
    this.lineProgram = compile(gl, linesVert, linesFrag);
    this.volumeUniforms = new Uniforms(gl, this.volumeProgram);
    this.lineUniforms = new Uniforms(gl, this.lineProgram);
    this.cube = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
    gl.bufferData(gl.ARRAY_BUFFER, cubeTriangles(), gl.STATIC_DRAW);
    this.volumes = [this.volumeTexture(), this.volumeTexture()];
    this.lut = gl.createTexture()!;
    this.edges = gl.createBuffer()!;
    const batch = new LineBatch();
    for (const { a, b } of EDGES) {
      batch.segment(
        a.map((s, i) => s * half[i]),
        b.map((s, i) => s * half[i]),
      );
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edges);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(batch.data),
      gl.STATIC_DRAW,
    );
  }

  private volumeTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const wrap of [
      gl.TEXTURE_WRAP_S,
      gl.TEXTURE_WRAP_T,
      gl.TEXTURE_WRAP_R,
    ]) {
      gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
    }
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RG16F,
      1,
      1,
      1,
      0,
      gl.RG,
      gl.FLOAT,
      new Float32Array(2),
    );
    return texture;
  }

  /** Uploads a month into slot 0 (current) or 1 (next). */
  setVolume(slot: 0 | 1, volume: Volume): void {
    const gl = this.gl;
    const { values } = volume;
    const pairs = new Float32Array(values.length * 2);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isNaN(value)) {
        pairs[i * 2] = value;
        pairs[i * 2 + 1] = 1;
      }
    }
    this.steps = volume.steps;
    gl.bindTexture(gl.TEXTURE_3D, this.volumes[slot]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RG16F,
      volume.cols,
      volume.rows,
      volume.steps,
      0,
      gl.RG,
      gl.FLOAT,
      pairs,
    );
  }

  /** Swaps the current and next months, when the next becomes current. */
  swapVolumes(): void {
    this.volumes = [this.volumes[1], this.volumes[0]];
  }

  setPalette(bytes: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      bytes.length / 4,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    );
  }

  /** Replaces a named set of line segments. */
  setLines(name: string, batch: LineBatch): void {
    const gl = this.gl;
    let lines = this.lines.get(name);
    if (!lines) {
      lines = { buffer: gl.createBuffer()!, count: 0 };
      this.lines.set(name, lines);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, lines.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(batch.data),
      gl.DYNAMIC_DRAW,
    );
    lines.count = batch.data.length / 4;
  }

  /** Whether a box face (unit normal) faces the viewer. */
  static faces(normal: readonly number[], ray: readonly number[]): boolean {
    return normal[0] * ray[0] + normal[1] * ray[1] + normal[2] * ray[2] < 0;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  render(frame: Frame, state: RenderState): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Volume.
    gl.useProgram(this.volumeProgram);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const u = this.volumeUniforms;
    gl.uniformMatrix4fv(u.get("u_vp"), false, frame.viewProjection);
    gl.uniform3fv(u.get("u_half"), this.half);
    gl.uniform3fv(u.get("u_ray"), frame.ray);
    gl.uniform1f(u.get("u_mix"), state.mix);
    gl.uniform2fv(u.get("u_domain"), state.domain);
    gl.uniform1f(u.get("u_steps_z"), this.steps);
    gl.uniform3fv(u.get("u_slice"), state.slice);
    gl.uniform3f(
      u.get("u_show"),
      state.show.slices ? 1 : 0,
      state.show.iso ? 1 : 0,
      state.show.contours ? 1 : 0,
    );
    gl.uniform1f(u.get("u_bottom"), state.bottom);
    gl.uniform1f(u.get("u_iso"), state.iso);
    gl.uniform1f(u.get("u_step"), state.step);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumes[0]);
    gl.uniform1i(u.get("u_vol_a"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.volumes[1]);
    gl.uniform1i(u.get("u_vol_b"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(u.get("u_lut"), 2);
    const position = gl.getAttribLocation(this.volumeProgram, "a_pos");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    gl.disableVertexAttribArray(position);
    gl.disable(gl.CULL_FACE);

    // Lines.
    gl.useProgram(this.lineProgram);
    gl.uniformMatrix4fv(
      this.lineUniforms.get("u_vp"),
      false,
      frame.viewProjection,
    );
    EDGES.forEach((edge, i) => {
      const visible = edge.faces.some((normal) =>
        CubeRenderer.faces(normal, frame.ray),
      );
      this.drawLines(
        this.edges,
        i * 2,
        2,
        visible ? [1, 1, 1, 0.75] : [1, 1, 1, 0.3],
        visible ? 0 : 0.03,
      );
    });
    const topVisible = CubeRenderer.faces([0, 0, 1], frame.ray);
    if (state.show.coast) {
      this.drawNamed("coast", [0.92, 0.94, 0.96, topVisible ? 0.85 : 0.18], 0);
    }
    this.drawNamed("ticks", [1, 1, 1, 0.55], 0);
    if (state.show.slices) {
      this.drawNamed("slices", [1, 1, 1, 0.5], 0);
    }
    if (state.show.roi) {
      this.drawNamed("roi", [1, 1, 1, 0.95], 0.04);
    }
  }

  private drawNamed(name: string, color: number[], dash: number): void {
    const lines = this.lines.get(name);
    if (lines && lines.count) {
      this.drawLines(lines.buffer, 0, lines.count, color, dash);
    }
  }

  private drawLines(
    buffer: WebGLBuffer,
    first: number,
    count: number,
    color: number[],
    dash: number,
  ): void {
    const gl = this.gl;
    const position = gl.getAttribLocation(this.lineProgram, "a_pos");
    const distance = gl.getAttribLocation(this.lineProgram, "a_dist");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(distance);
    gl.vertexAttribPointer(distance, 1, gl.FLOAT, false, 16, 12);
    gl.uniform4fv(this.lineUniforms.get("u_color"), color);
    gl.uniform1f(this.lineUniforms.get("u_dash"), dash);
    gl.drawArrays(gl.LINES, first, count);
    gl.disableVertexAttribArray(position);
    gl.disableVertexAttribArray(distance);
  }
}
