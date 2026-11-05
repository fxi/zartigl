/**
 * Orthographic views of the cube, as in CAD: ISO, TOP, FRONT, SIDE and an
 * oblique cavalier projection. World axes: x east, y north, z up. Every view
 * is affine, so rays through the screen are parallel and the raymarch and the
 * picking use one direction for the whole frame.
 */

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

/** Column-major product a · b. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Inverse of an affine matrix (last row 0, 0, 0, 1). */
export function invertAffine(m: Mat4): Mat4 {
  const [a, b, c] = [m[0], m[4], m[8]];
  const [d, e, f] = [m[1], m[5], m[9]];
  const [g, h, i] = [m[2], m[6], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inv = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const [tx, ty, tz] = [m[12], m[13], m[14]];
  const out = new Float32Array(16);
  out[0] = inv[0];
  out[4] = inv[1];
  out[8] = inv[2];
  out[1] = inv[3];
  out[5] = inv[4];
  out[9] = inv[5];
  out[2] = inv[6];
  out[6] = inv[7];
  out[10] = inv[8];
  out[12] = -(inv[0] * tx + inv[1] * ty + inv[2] * tz);
  out[13] = -(inv[3] * tx + inv[4] * ty + inv[5] * tz);
  out[14] = -(inv[6] * tx + inv[7] * ty + inv[8] * tz);
  out[15] = 1;
  return out;
}

/** m · (x, y, z, w), the first three components. */
export function transform(m: Mat4, p: readonly number[], w = 1): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w,
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w,
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * w,
  ];
}

function columns(...rows: number[][]): Mat4 {
  const out = new Float32Array(16);
  rows.forEach((row, r) => row.forEach((value, c) => (out[c * 4 + r] = value)));
  return out;
}

export interface View {
  /** Turn about the vertical axis, radians; 0 looks north from the south. */
  yaw: number;
  /** Tilt downwards, radians; π/2 looks straight down. */
  pitch: number;
  /** Cavalier obliqueness, 0 (orthographic) to 1. */
  oblique: number;
  /** Screen half-heights per world unit. */
  zoom: number;
}

export type Preset = "iso" | "top" | "front" | "side" | "cavalier";

const DEG = Math.PI / 180;

export const PRESETS: Record<Preset, View> = {
  iso: { yaw: -32 * DEG, pitch: 24 * DEG, oblique: 0, zoom: 0.78 },
  top: { yaw: 0, pitch: 90 * DEG, oblique: 0, zoom: 0.92 },
  front: { yaw: 0, pitch: 0, oblique: 0, zoom: 0.92 },
  side: { yaw: -90 * DEG, pitch: 0, oblique: 0, zoom: 1.6 },
  cavalier: { yaw: 0, pitch: 0, oblique: 1, zoom: 0.7 },
};

/** Cavalier receding axis: half length, at 35° above the horizontal. */
const CAVALIER = { scale: 0.5, angle: 35 * DEG };

/** World → view: x right, y up, z towards the viewer. */
export function viewMatrix(view: View): Mat4 {
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  // Turn about z, then the front view (x, y, z) → (x, z, −y), then tilt about x.
  const yaw = columns(
    [cy, -sy, 0, 0],
    [sy, cy, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  );
  const front = columns(
    [1, 0, 0, 0],
    [0, 0, 1, 0],
    [0, -1, 0, 0],
    [0, 0, 0, 1],
  );
  const tilt = columns(
    [1, 0, 0, 0],
    [0, cp, -sp, 0],
    [0, sp, cp, 0],
    [0, 0, 0, 1],
  );
  const k = view.oblique * CAVALIER.scale;
  // The receding axis (into the screen, −z) drawn up and to the right.
  const shear = columns(
    [1, 0, -k * Math.cos(CAVALIER.angle), 0],
    [0, 1, -k * Math.sin(CAVALIER.angle), 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  );
  return multiply(shear, multiply(tilt, multiply(front, yaw)));
}

/** View → clip, for a viewport of `aspect` = width / height. */
export function projectionMatrix(view: View, aspect: number): Mat4 {
  const z = 1 / 4;
  return columns(
    [view.zoom / aspect, 0, 0, 0],
    [0, view.zoom, 0, 0],
    [0, 0, -z, 0],
    [0, 0, 0, 1],
  );
}

export interface Frame {
  viewProjection: Mat4;
  inverse: Mat4;
  /** World direction into the screen, normalized. */
  ray: Vec3;
}

export function frame(view: View, aspect: number): Frame {
  const viewProjection = multiply(
    projectionMatrix(view, aspect),
    viewMatrix(view),
  );
  const inverse = invertAffine(viewProjection);
  const ray = transform(inverse, [0, 0, 1], 0);
  const length = Math.hypot(...ray);
  return {
    viewProjection,
    inverse,
    ray: [ray[0] / length, ray[1] / length, ray[2] / length],
  };
}

/** Screen pixel of a world point. */
export function project(
  f: Frame,
  p: readonly number[],
  width: number,
  height: number,
): [number, number] {
  const [x, y] = transform(f.viewProjection, p);
  return [((x + 1) / 2) * width, ((1 - y) / 2) * height];
}

/** World point on the near plane under a screen pixel. */
export function unproject(
  f: Frame,
  px: number,
  py: number,
  width: number,
  height: number,
): Vec3 {
  return transform(f.inverse, [
    (px / width) * 2 - 1,
    1 - (py / height) * 2,
    -1,
  ]);
}

/** Linear blend of two views, for preset transitions. */
export function blendViews(a: View, b: View, t: number): View {
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    yaw: mix(a.yaw, b.yaw),
    pitch: mix(a.pitch, b.pitch),
    oblique: mix(a.oblique, b.oblique),
    zoom: mix(a.zoom, b.zoom),
  };
}
