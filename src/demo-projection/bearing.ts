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
