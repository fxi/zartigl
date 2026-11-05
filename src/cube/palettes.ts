/**
 * Color ramps of the cube, as 256 RGB triples (0–255). Turbo is a
 * perceptually smoothed rainbow (Google's polynomial approximation, Apache
 * 2.0); thermal is the catalog's temperature palette (cmocean).
 */

import palettes from "../lib/palettes.json";

export type PaletteName = "turbo" | "thermal";

export const PALETTE_LABELS: Record<PaletteName, string> = {
  turbo: "Turbo",
  thermal: "Thermal",
};

const SIZE = 256;

function turbo(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r =
    0.13572138 +
    x *
      (4.6153926 +
        x *
          (-42.66032258 +
            x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g =
    0.09140261 +
    x *
      (2.19418839 +
        x *
          (4.84296658 +
            x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b =
    0.1066733 +
    x *
      (12.64194608 +
        x *
          (-60.58204836 +
            x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [r, g, b].map((v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255),
  ) as [number, number, number];
}

function hex(color: string): [number, number, number] {
  const value = parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function stops(colors: string[]): (t: number) => [number, number, number] {
  const rgb = colors.map(hex);
  return (t) => {
    const x = Math.min(1, Math.max(0, t)) * (rgb.length - 1);
    const i = Math.min(rgb.length - 2, Math.floor(x));
    const f = x - i;
    return rgb[i].map((v, c) => Math.round(v + (rgb[i + 1][c] - v) * f)) as [
      number,
      number,
      number,
    ];
  };
}

/** RGBA bytes of a ramp, 256 × 1. */
export function rampBytes(name: PaletteName): Uint8Array {
  const color =
    name === "turbo"
      ? turbo
      : stops(
          (palettes as Record<string, { colors: string[] }>).thermal.colors,
        );
  const bytes = new Uint8Array(SIZE * 4);
  for (let i = 0; i < SIZE; i++) {
    const [r, g, b] = color(i / (SIZE - 1));
    bytes.set([r, g, b, 255], i * 4);
  }
  return bytes;
}

/** CSS color of a ramp position, for the 2D panels and the legend. */
export function rampColor(
  bytes: Uint8Array,
  t: number,
): [number, number, number] {
  const i = Math.round(Math.min(1, Math.max(0, t)) * (SIZE - 1)) * 4;
  return [bytes[i], bytes[i + 1], bytes[i + 2]];
}
