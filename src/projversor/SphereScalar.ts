import type { GeoVideoBounds } from "../engine";
import type { GeoVideoField } from "./GeoVideoField";
import backdropFrag from "./shaders/backdrop.frag.glsl";
import rasterFrag from "./shaders/raster.frag.glsl";
import rasterVert from "./shaders/raster.vert.glsl";
import { Program, compositeBlend, isGlobalGrid, type ViewFrame } from "./view";

export interface RasterStyle {
  ramp: WebGLTexture;
  /** Values mapped linearly onto the ramp. */
  domain: [number, number];
  opacity: number;
  /** Catalog vibrance, as zartigl's scalar shaders. */
  vibrance: number;
}

/** Mesh cell size bounds, in degrees: fine on regional grids, coarse on global ones. */
const CELL_MIN = 0.25;
const CELL_MAX = 2;
/** Triangles with an edge longer than this (radians at the view scale) cross a cut. */
const MAX_JUMP = 0.3;

/** Mesh columns and rows over `bounds`, about 180 cells along the longer side. */
export function gridCells(bounds: GeoVideoBounds): [number, number] {
  const [west, south, east, north] = bounds;
  const lon = east - west;
  const lat = north - south;
  const cell = Math.min(CELL_MAX, Math.max(CELL_MIN, Math.max(lon, lat) / 180));
  return [
    Math.max(1, Math.ceil(lon / cell)),
    Math.max(1, Math.ceil(lat / cell)),
  ];
}

/**
 * Area the mesh covers: a global grid whose east edge stops short of
 * 180° (cell centers) is closed to a full turn, its texture repeating
 * across the seam; a regional grid covers its own bounds.
 */
export function meshBounds(bounds: GeoVideoBounds): GeoVideoBounds {
  const [west, south, , north] = bounds;
  return isGlobalGrid(bounds) ? [west, south, west + 360, north] : bounds;
}

/**
 * A scalar GeoVideo field (TINT_UNIFORMS) drawn as a raster on the sphere: a
 * lon/lat mesh over its bounds, projected with the current view, so it
 * morphs with the projections like the particles and the coastlines. The
 * same mesh draws the particle backdrop of a vector field.
 */
export class SphereScalar {
  private readonly program: Program;
  private readonly backdrop: Program;
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = new Program(gl, rasterVert, rasterFrag);
    this.backdrop = new Program(gl, rasterVert, backdropFrag);
    // Attribute-less draws still want a bound vertex array.
    this.vao = gl.createVertexArray();
  }

  /** Draw over the bound framebuffer; false until the field has a frame. */
  draw(
    frame: ViewFrame,
    field: GeoVideoField,
    ms: number,
    style: RasterStyle,
  ): boolean {
    const p = this.program.use();
    if (!field.bind(p, ms)) {
      return false;
    }
    p.texture("u_ramp", 2, style.ramp);
    p.vec2("u_domain", ...style.domain);
    p.float("u_opacity", style.opacity);
    p.float("u_vibrance", style.vibrance);
    this.drawMesh(p, frame, field);
    return true;
  }

  /**
   * Flat `solid` color (straight RGB, alpha) on the valid cells of a vector
   * field, over the bound framebuffer; false until the field has a frame.
   */
  drawBackdrop(
    frame: ViewFrame,
    field: GeoVideoField,
    ms: number,
    solid: [number, number, number, number],
  ): boolean {
    const p = this.backdrop.use();
    if (!field.bind(p, ms)) {
      return false;
    }
    p.vec4("u_solid", solid);
    this.drawMesh(p, frame, field);
    return true;
  }

  destroy(): void {
    this.program.delete();
    this.backdrop.delete();
    this.gl.deleteVertexArray(this.vao);
  }

  private drawMesh(p: Program, frame: ViewFrame, field: GeoVideoField): void {
    const gl = this.gl;
    const mesh = meshBounds(field.bounds);
    const [cols, rows] = gridCells(mesh);
    p.projection(frame);
    p.mat3("u_rot", frame.rot);
    p.vec4("u_grid", mesh);
    p.int("u_cols", cols);
    p.int("u_rows", rows);
    p.float("u_max_jump", MAX_JUMP * frame.pxPerRadian);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    compositeBlend(gl);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, cols * rows * 6);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
