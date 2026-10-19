import {
  geoAzimuthalEqualAreaRaw,
  geoAzimuthalEquidistantRaw,
  geoEqualEarthRaw,
  geoEquirectangularRaw,
  geoOrthographicRaw,
  geoRotation,
  type GeoRawProjection,
} from "d3";

/**
 * World projections shared by d3 (overlay) and GLSL (raster, particles).
 * Each raw formula has a twin in shaders/project.glsl keyed by `glslId`;
 * both sides must stay identical or the coastlines drift off the raster.
 */
export type ProjectionId =
  | "equirectangular"
  | "equalEarth"
  | "mollweide"
  | "azimuthalEqualArea"
  | "azimuthalEquidistant"
  | "orthographic";

export interface ProjectionDef {
  id: ProjectionId;
  label: string;
  glslId: number;
  raw: GeoRawProjection;
  /** Half width and half height of the world outline, in raw units. */
  extent: [number, number];
  /** Hemisphere-limited projections clip at this angle (degrees). */
  clipAngle: number;
  /** Azimuthal projections are cut around the antipode, not along a meridian. */
  azimuthal: boolean;
}

type RawFn = (lambda: number, phi: number) => [number, number];

// d3 types these exports as factories; at runtime they are the raw functions.
const asRaw = (raw: unknown): GeoRawProjection => raw as GeoRawProjection;

const MOLLWEIDE_CX = (2 * Math.SQRT2) / Math.PI;
const MOLLWEIDE_CY = Math.SQRT2;

/** Newton solve of 2θ + sin 2θ = π sin φ, as d3-geo-projection does. */
export function mollweideTheta(phi: number): number {
  const target = Math.PI * Math.sin(phi);
  let x = phi;
  for (let i = 0; i < 12; i++) {
    const delta = (x + Math.sin(x) - target) / (1 + Math.cos(x));
    if (!Number.isFinite(delta)) {
      break;
    }
    x -= delta;
    if (Math.abs(delta) < 1e-9) {
      break;
    }
  }
  return x / 2;
}

const mollweideRaw = ((lambda: number, phi: number): [number, number] => {
  const theta = mollweideTheta(phi);
  return [
    MOLLWEIDE_CX * lambda * Math.cos(theta),
    MOLLWEIDE_CY * Math.sin(theta),
  ];
}) as GeoRawProjection;

mollweideRaw.invert = (x: number, y: number): [number, number] => {
  const theta = Math.asin(Math.max(-1, Math.min(1, y / MOLLWEIDE_CY)));
  return [
    x / (MOLLWEIDE_CX * Math.cos(theta)),
    Math.asin(
      Math.max(-1, Math.min(1, (2 * theta + Math.sin(2 * theta)) / Math.PI)),
    ),
  ];
};

const equalEarthRaw = asRaw(geoEqualEarthRaw);

export const PROJECTIONS: Record<ProjectionId, ProjectionDef> = {
  equirectangular: {
    id: "equirectangular",
    label: "Equirectangular",
    glslId: 0,
    raw: asRaw(geoEquirectangularRaw),
    extent: [Math.PI, Math.PI / 2],
    clipAngle: 180,
    azimuthal: false,
  },
  equalEarth: {
    id: "equalEarth",
    label: "Equal Earth",
    glslId: 1,
    raw: equalEarthRaw,
    extent: [equalEarthRaw(Math.PI, 0)[0], equalEarthRaw(0, Math.PI / 2)[1]],
    clipAngle: 180,
    azimuthal: false,
  },
  mollweide: {
    id: "mollweide",
    label: "Mollweide",
    glslId: 2,
    raw: mollweideRaw,
    extent: [MOLLWEIDE_CX * Math.PI, MOLLWEIDE_CY],
    clipAngle: 180,
    azimuthal: false,
  },
  azimuthalEqualArea: {
    id: "azimuthalEqualArea",
    label: "Azimuthal equal-area",
    glslId: 3,
    raw: asRaw(geoAzimuthalEqualAreaRaw),
    extent: [2, 2],
    clipAngle: 180,
    azimuthal: true,
  },
  azimuthalEquidistant: {
    id: "azimuthalEquidistant",
    label: "Azimuthal equidistant",
    glslId: 4,
    raw: asRaw(geoAzimuthalEquidistantRaw),
    extent: [Math.PI, Math.PI],
    clipAngle: 180,
    azimuthal: true,
  },
  orthographic: {
    id: "orthographic",
    label: "Orthographic",
    glslId: 5,
    raw: asRaw(geoOrthographicRaw),
    extent: [1, 1],
    clipAngle: 90,
    azimuthal: true,
  },
};

/** Pixels per raw unit that fit a projection's world outline in a viewport. */
export function fitScale(
  def: ProjectionDef,
  width: number,
  height: number,
  margin = 0.92,
): number {
  return (
    margin * Math.min(width / (2 * def.extent[0]), height / (2 * def.extent[1]))
  );
}

/** Interpolation state of the projection between two world projections. */
export interface Blend {
  a: ProjectionDef;
  b: ProjectionDef;
  /** Fit scales (pixels per raw unit) of a and b. */
  ka: number;
  kb: number;
  /** 0 = a, 1 = b. */
  t: number;
}

/** P(t) = (1 - t)·ka·A + t·kb·B, in pixels before zoom. */
export function blendRaw(blend: Blend): RawFn {
  return (lambda, phi) => {
    const { a, b, ka, kb, t } = blend;
    if (t <= 0) {
      const p = a.raw(lambda, phi);
      return [ka * p[0], ka * p[1]];
    }
    if (t >= 1) {
      const p = b.raw(lambda, phi);
      return [kb * p[0], kb * p[1]];
    }
    const pa = a.raw(lambda, phi);
    const pb = b.raw(lambda, phi);
    return [
      (1 - t) * ka * pa[0] + t * kb * pb[0],
      (1 - t) * ka * pa[1] + t * kb * pb[1],
    ];
  };
}

/**
 * Inverse of the blended raw projection by Newton iteration, seeded by the
 * dominant projection's own inverse. Returns null outside the projection.
 */
export function invertBlend(
  blend: Blend,
  x: number,
  y: number,
): [number, number] | null {
  const forward = blendRaw(blend);
  const dominant = blend.t < 0.5 ? blend.a : blend.b;
  const k = blend.t < 0.5 ? blend.ka : blend.kb;
  const seed = dominant.raw.invert?.(x / k, y / k);
  let lambda = seed && Number.isFinite(seed[0]) ? seed[0] : 0;
  let phi = seed && Number.isFinite(seed[1]) ? seed[1] : 0;
  const h = 1e-6;
  for (let i = 0; i < 25; i++) {
    const [fx, fy] = forward(lambda, phi);
    const ex = fx - x;
    const ey = fy - y;
    if (Math.hypot(ex, ey) < 1e-6) {
      return Math.abs(lambda) <= Math.PI + 1e-9 &&
        Math.abs(phi) <= Math.PI / 2 + 1e-9
        ? [lambda, phi]
        : null;
    }
    const [lx, ly] = forward(lambda + h, phi);
    const [px, py] = forward(lambda, phi + h);
    const j11 = (lx - fx) / h;
    const j21 = (ly - fy) / h;
    const j12 = (px - fx) / h;
    const j22 = (py - fy) / h;
    const det = j11 * j22 - j12 * j21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      return null;
    }
    lambda -= (j22 * ex - j12 * ey) / det;
    phi -= (j11 * ey - j21 * ex) / det;
    phi = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, phi));
  }
  return null;
}

/**
 * Clip angle (degrees) of a blend. A hemisphere projection folds back past
 * its horizon; blended with a world projection the fold moves outward, so
 * the clip follows the first angle where the radius along the rotated
 * equator stops growing. 180 means no circle clip (antimeridian cut).
 */
/** Circle clip of azimuthal projections, degrees. */
export const AZIMUTHAL_CLIP = 179.9;

export function blendClipAngle(blend: Blend): number {
  const dominant = blend.t < 0.5 ? blend.a : blend.b;
  // As d3 does for azimuthals: a small circle just short of the antipode.
  const open = dominant.azimuthal ? AZIMUTHAL_CLIP : 180;
  if (blend.a.clipAngle >= 180 && blend.b.clipAngle >= 180) {
    return open;
  }
  if (blend.t <= 0) {
    return blend.a.clipAngle;
  }
  if (blend.t >= 1) {
    return blend.b.clipAngle;
  }
  const forward = blendRaw(blend);
  const step = 0.25;
  let previous = forward((90 * Math.PI) / 180, 0)[0];
  for (let c = 90 + step; c < 180; c += step) {
    const x = forward((c * Math.PI) / 180, 0)[0];
    if (x <= previous) {
      return Math.min(c - step, open);
    }
    previous = x;
  }
  return open;
}

export type Vec3 = [number, number, number];
/** Column-major 3×3, as WebGL uniformMatrix3fv expects. */
export type Mat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const RADIANS = Math.PI / 180;
const DEGREES = 180 / Math.PI;

/** d3 cartesian convention: x toward (0°, 0°), z toward the north pole. */
export function cartesian(lonDeg: number, latDeg: number): Vec3 {
  const l = lonDeg * RADIANS;
  const p = latDeg * RADIANS;
  const cp = Math.cos(p);
  return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)];
}

export function spherical(v: Vec3): [number, number] {
  return [
    Math.atan2(v[1], v[0]) * DEGREES,
    Math.asin(Math.max(-1, Math.min(1, v[2]))) * DEGREES,
  ];
}

/**
 * Matrix of d3's rotate([λ, φ, γ]) acting on cartesian vectors (geographic →
 * rotated frame). Built from d3 itself so GLSL cannot disagree with it.
 */
export function rotationMatrix(rotate: [number, number, number]): Mat3 {
  const rotation = geoRotation(rotate);
  const columns = [
    cartesian(...(rotation([0, 0]) as [number, number])),
    cartesian(...(rotation([90, 0]) as [number, number])),
    cartesian(...(rotation([0, 90]) as [number, number])),
  ];
  return columns.flat() as Mat3;
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}
