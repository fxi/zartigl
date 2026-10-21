import type { BackdropStyle } from "../catalog/style";

/** Particle backdrop off: see BackdropStyle. */
export const BACKDROP_OFF: Readonly<BackdropStyle> = Object.freeze({
  enabled: false,
  color: "#000000",
  opacity: 0.5,
});

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A `#rgb` or `#rrggbb` color. */
export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && HEX_COLOR.test(value);

/**
 * Complete backdrop from partial input. Missing or invalid values take the
 * defaults, opacity is clamped; `enabled` defaults to true when any input is
 * given, so `{ opacity: 0.2 }` means "on".
 */
export function resolveBackdrop(input?: Partial<BackdropStyle>): BackdropStyle {
  if (!input) {
    return { ...BACKDROP_OFF };
  }
  const backdrop: BackdropStyle = { ...BACKDROP_OFF, enabled: true };
  if (typeof input.enabled === "boolean") {
    backdrop.enabled = input.enabled;
  }
  if (isHexColor(input.color)) {
    backdrop.color = input.color;
  }
  if (typeof input.opacity === "number" && Number.isFinite(input.opacity)) {
    backdrop.opacity = Math.min(1, Math.max(0, input.opacity));
  }
  return backdrop;
}

/**
 * `u_solid` uniform: straight RGB in [0, 1] and opacity. Alpha is 0 when the
 * backdrop is off, which also skips the draw.
 */
export function backdropVec4(
  backdrop: BackdropStyle,
): [number, number, number, number] {
  const hex = backdrop.color.slice(1);
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return [
    channel(0),
    channel(2),
    channel(4),
    backdrop.enabled ? backdrop.opacity : 0,
  ];
}
