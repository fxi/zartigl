import { resolveColorRamp } from "../lib/gl-util";

/**
 * Css gradient of a palette, bottom to top. Stops are sorted numerically:
 * integer-like keys ("0", "1") would otherwise enumerate first and scramble
 * the gradient.
 */
export function rampGradient(palette: string): string {
  const stops = Object.entries(resolveColorRamp(palette))
    .map(([stop, color]) => [Number(stop), color] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([stop, color]) => `${color} ${stop * 100}%`);
  return `linear-gradient(to top, ${stops.join(", ")})`;
}

/** Position on the ramp of a value; the shaders color by sqrt(value / max). */
export function rampPosition(value: number, max: number): number {
  return Math.sqrt(Math.max(0, Math.min(1, value / max)));
}

/** Rounded legend values spread evenly along a square-root ramp. */
export function legendTicks(max: number): number[] {
  const top = Number(max.toPrecision(2));
  const ticks = [0];
  for (const p of [0.25, 0.45, 0.65, 0.85]) {
    const value = roundNice(max * p * p);
    const previous = ticks[ticks.length - 1];
    if (
      value > previous &&
      rampPosition(value, max) - rampPosition(previous, max) >= MIN_GAP &&
      rampPosition(top, max) - rampPosition(value, max) >= MIN_GAP
    ) {
      ticks.push(value);
    }
  }
  ticks.push(top);
  return ticks;
}

/** Minimum distance between two legend labels, as a ramp fraction. */
const MIN_GAP = 0.08;
const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Closest (in ratio) of 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ. */
function roundNice(value: number): number {
  const decade = 10 ** Math.floor(Math.log10(value));
  let best = decade;
  for (const n of NICE) {
    const candidate = n * decade;
    if (
      Math.abs(Math.log(candidate / value)) < Math.abs(Math.log(best / value))
    ) {
      best = candidate;
    }
  }
  return Number(best.toPrecision(2));
}

const DAY_MS = 86_400_000;

/**
 * UTC day marks as positions along [first, last]; the 1st and every 5th
 * are major (labelled).
 */
export function dayTicks(
  first: number,
  last: number,
): { label: string; position: number; major: boolean }[] {
  const ticks: { label: string; position: number; major: boolean }[] = [];
  for (let t = Math.ceil(first / DAY_MS) * DAY_MS; t <= last; t += DAY_MS) {
    const date = new Date(t).getUTCDate();
    ticks.push({
      label: String(date).padStart(2, "0"),
      position: (t - first) / (last - first),
      major: date === 1 || date % 5 === 0,
    });
  }
  return ticks;
}

/** The next (1) or previous (-1) UTC midnight, strictly after or before `ms`. */
export function stepDay(ms: number, direction: 1 | -1): number {
  return direction > 0
    ? Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS
    : Math.ceil(ms / DAY_MS) * DAY_MS - DAY_MS;
}

/** "m s-1" → "m/s". */
export function formatUnit(unit: string | undefined): string {
  return (unit ?? "").replace(/ s-1$/, "/s").replace(/ s-2$/, "/s²");
}

/** zartigl particle settings, as in catalog `defaults.particles`. */
export interface ParticleSettings {
  /** Particles per device pixel. */
  density: number;
  /** Css px per frame at the top of the speed range. */
  speed: number;
  /** Trail length, 0–1 (20 to 600 frames). */
  fade: number;
}

/** zartigl VectorLayer defaults. */
const DEFAULT_PARTICLES: ParticleSettings = {
  density: 0.05,
  speed: 1,
  fade: 0.7,
};

/** Demo defaults, then the catalog entry defaults, then the demo override. */
export function particleSettings(
  catalog: Partial<ParticleSettings> | undefined,
  override: Partial<ParticleSettings> | undefined,
): ParticleSettings {
  return { ...DEFAULT_PARTICLES, ...catalog, ...override };
}

/** zartigl's MAX_PARTICLES (512² state texture). */
export const MAX_PARTICLES = 512 * 512;

/** Drawn particle count for a device-pixel canvas, as zartigl. */
export function particleCount(
  settings: ParticleSettings,
  widthPx: number,
  heightPx: number,
): number {
  return Math.max(
    1,
    Math.min(MAX_PARTICLES, Math.round(widthPx * heightPx * settings.density)),
  );
}
