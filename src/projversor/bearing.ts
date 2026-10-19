/** Wrap degrees into [-180, 180). */
export function normalizeBearing(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Screen angle of (x, y) around (cx, cy), clockwise from up, in degrees. */
export function pointerBearing(
  cx: number,
  cy: number,
  x: number,
  y: number,
): number {
  return (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
}

/**
 * d3 rotation with the given bearing: the screen angle, clockwise from up,
 * of north at the view center. d3's gamma turns the map counter-clockwise.
 */
export function withBearing(
  [lambda, phi]: [number, number, number],
  deg: number,
): [number, number, number] {
  return [lambda, phi, -normalizeBearing(deg)];
}

/** Bearing of a d3 rotation; inverse of {@link withBearing}. */
export function rotationBearing(rotate: [number, number, number]): number {
  return normalizeBearing(-rotate[2]);
}

/** A projection from [lon, lat] to css px, with its inverse. */
export interface ScreenProjection {
  (point: [number, number]): [number, number] | null;
  invert?(point: [number, number]): [number, number] | null;
}

/** Latitudes beyond which north has no single screen direction. */
const POLE_LAT = 89;

/**
 * Screen direction of north at css point `at`, in degrees clockwise from
 * up: the angle toward a point just north of it. Unlike the rotation's
 * bearing, it holds on any projection, tilted or not. Null off the map and
 * near a pole, where every direction is north (or south).
 */
export function screenNorth(
  projection: ScreenProjection,
  at: [number, number],
): number | null {
  const lonLat = projection.invert?.(at);
  if (
    !lonLat ||
    !Number.isFinite(lonLat[0]) ||
    !Number.isFinite(lonLat[1]) ||
    Math.abs(lonLat[1]) > POLE_LAT
  ) {
    return null;
  }
  const here = projection(lonLat);
  const north = projection([lonLat[0], lonLat[1] + 0.5]);
  // Some inverses answer off the map too: keep points that project back.
  if (!here || !north || Math.hypot(here[0] - at[0], here[1] - at[1]) > 1) {
    return null;
  }
  const dx = north[0] - here[0];
  const dy = north[1] - here[1];
  if (!(Math.hypot(dx, dy) > 1e-6)) {
    return null;
  }
  return normalizeBearing(pointerBearing(here[0], here[1], north[0], north[1]));
}
