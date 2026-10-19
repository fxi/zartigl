import type { Vec3 } from "./projections";

/**
 * Unit quaternions for "grab the sphere" rotation, after Mike Bostock's
 * versor (also used by d3-geo-zoom). Rotations are d3 Euler angles in degrees.
 */
export type Versor = [number, number, number, number];

const RADIANS = Math.PI / 180;
const DEGREES = 180 / Math.PI;

export function versor([l, p, g]: [number, number, number]): Versor {
  const hl = (l / 2) * RADIANS;
  const hp = (p / 2) * RADIANS;
  const hg = (g / 2) * RADIANS;
  const sl = Math.sin(hl);
  const cl = Math.cos(hl);
  const sp = Math.sin(hp);
  const cp = Math.cos(hp);
  const sg = Math.sin(hg);
  const cg = Math.cos(hg);
  return [
    cl * cp * cg + sl * sp * sg,
    sl * cp * cg - cl * sp * sg,
    cl * sp * cg + sl * cp * sg,
    cl * cp * sg - sl * sp * cg,
  ];
}

export function versorRotation(q: Versor): [number, number, number] {
  return [
    Math.atan2(
      2 * (q[0] * q[1] + q[2] * q[3]),
      1 - 2 * (q[1] * q[1] + q[2] * q[2]),
    ) * DEGREES,
    Math.asin(Math.max(-1, Math.min(1, 2 * (q[0] * q[2] - q[3] * q[1])))) *
      DEGREES,
    Math.atan2(
      2 * (q[0] * q[3] + q[1] * q[2]),
      1 - 2 * (q[2] * q[2] + q[3] * q[3]),
    ) * DEGREES,
  ];
}

export function versorMultiply(a: Versor, b: Versor): Versor {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[1] * b[0] + a[0] * b[1] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** Rotation taking cartesian v0 onto v1. */
export function versorDelta(v0: Vec3, v1: Vec3): Versor {
  const w: Vec3 = [
    v0[1] * v1[2] - v0[2] * v1[1],
    v0[2] * v1[0] - v0[0] * v1[2],
    v0[0] * v1[1] - v0[1] * v1[0],
  ];
  const l = Math.hypot(...w);
  if (!l) {
    return [1, 0, 0, 0];
  }
  const dot = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
  const t = Math.acos(Math.max(-1, Math.min(1, dot))) / 2;
  const s = Math.sin(t);
  return [Math.cos(t), (w[2] / l) * s, (-w[1] / l) * s, (w[0] / l) * s];
}

/** Shortest-path interpolation between two rotations. */
export function interpolateRotation(
  from: [number, number, number],
  to: [number, number, number],
): (t: number) => [number, number, number] {
  const a = versor(from);
  let b = versor(to);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    b = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  const theta = Math.acos(Math.min(1, dot));
  const sin = Math.sin(theta);
  return (t) => {
    if (sin < 1e-6) {
      return versorRotation(t < 1 ? a : b);
    }
    const wa = Math.sin((1 - t) * theta) / sin;
    const wb = Math.sin(t * theta) / sin;
    return versorRotation([
      wa * a[0] + wb * b[0],
      wa * a[1] + wb * b[1],
      wa * a[2] + wb * b[2],
      wa * a[3] + wb * b[3],
    ]);
  };
}
