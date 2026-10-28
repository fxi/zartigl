/** One bound velocity texture and the physical range used to decode it. */
export interface VelocityTextureField {
  unit: number;
  min: [number, number];
  max: [number, number];
  /** Physical (u, v, validity, 0); otherwise normalized (u, v, 0, validity). */
  physical?: boolean;
  northToSouth?: boolean;
}

export interface VelocityTexturePair {
  a: VelocityTextureField;
  b: VelocityTextureField;
  mix: number;
}

export const VELOCITY_PAIR_UNIFORMS = [
  "u_velocity_next",
  "u_velocity_next_min",
  "u_velocity_next_max",
  "u_velocity_mix",
  "u_velocity_physical",
  "u_velocity_next_physical",
  "u_velocity_flip_y",
  "u_velocity_next_flip_y",
];

/** Pair uniforms shared by the advection, particle color and speed raster passes. */
export function setVelocityPairUniforms(
  gl: WebGL2RenderingContext,
  locs: Record<string, WebGLUniformLocation | null>,
  pair: VelocityTexturePair,
): void {
  gl.uniform1i(locs.u_velocity_next, pair.b.unit);
  gl.uniform2f(locs.u_velocity_next_min, ...pair.b.min);
  gl.uniform2f(locs.u_velocity_next_max, ...pair.b.max);
  gl.uniform1f(locs.u_velocity_mix, pair.mix);
  gl.uniform1f(locs.u_velocity_physical, pair.a.physical ? 1 : 0);
  gl.uniform1f(locs.u_velocity_next_physical, pair.b.physical ? 1 : 0);
  gl.uniform1f(locs.u_velocity_flip_y, pair.a.northToSouth ? 1 : 0);
  gl.uniform1f(locs.u_velocity_next_flip_y, pair.b.northToSouth ? 1 : 0);
}
