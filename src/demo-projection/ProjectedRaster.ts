import type { CurrentField } from "./CurrentField";
import rasterFrag from "./shaders/raster.frag.glsl";
import rasterVert from "./shaders/raster.vert.glsl";
import { Program, type ViewFrame } from "./view";

/**
 * Regular lon/lat grid of the rotated frame, in radians. Its border is the
 * cut of every projection, so no triangle straddles a discontinuity.
 */
export function rotatedGrid(stepDeg: number): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const cols = Math.round(360 / stepDeg);
  const rows = Math.round(180 / stepDeg);
  const vertices = new Float32Array((cols + 1) * (rows + 1) * 2);
  let k = 0;
  for (let j = 0; j <= rows; j++) {
    const phi = -Math.PI / 2 + (j / rows) * Math.PI;
    for (let i = 0; i <= cols; i++) {
      vertices[k++] = -Math.PI + (i / cols) * 2 * Math.PI;
      vertices[k++] = phi;
    }
  }
  const indices = new Uint32Array(cols * rows * 6);
  k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + cols + 1;
      indices.set([a, a + 1, b, a + 1, b + 1, b], k);
      k += 6;
    }
  }
  return { vertices, indices };
}

/** Current speed raster, forward-projected as a mesh. */
export class ProjectedRaster {
  private readonly program: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[];
  private readonly count: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    stepDeg = 0.5,
  ) {
    this.program = new Program(gl, rasterVert, rasterFrag);
    const { vertices, indices } = rotatedGrid(stepDeg);
    this.count = indices.length;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.program.program, "a_lonlat");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.buffers = [vbo, ibo];
  }

  draw(
    frame: ViewFrame,
    field: CurrentField,
    ms: number,
    style: { ramp: WebGLTexture; maxSpeed: number; brightness: number },
  ): void {
    const gl = this.gl;
    const p = this.program.use();
    if (!field.bind(p, ms)) {
      return;
    }
    p.projection(frame);
    p.mat3("u_rot_inv", frame.rotInv);
    p.texture("u_ramp", 2, style.ramp);
    p.float("u_max_speed", style.maxSpeed);
    p.float("u_brightness", style.brightness);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }

  destroy(): void {
    this.program.delete();
    this.gl.deleteVertexArray(this.vao);
    for (const buffer of this.buffers) {
      this.gl.deleteBuffer(buffer);
    }
  }
}
