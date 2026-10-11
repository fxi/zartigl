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

/** UTC day marks (1st and every 5th) as positions along [first, last]. */
export function dayTicks(
  first: number,
  last: number,
): { label: string; position: number }[] {
  const day = 86_400_000;
  const ticks: { label: string; position: number }[] = [];
  for (let t = Math.ceil(first / day) * day; t <= last; t += day) {
    const date = new Date(t).getUTCDate();
    if (date === 1 || date % 5 === 0) {
      ticks.push({
        label: String(date).padStart(2, "0"),
        position: (t - first) / (last - first),
      });
    }
  }
  return ticks;
}

/** "m s-1" → "m/s". */
export function formatUnit(unit: string | undefined): string {
  return (unit ?? "").replace(/ s-1$/, "/s").replace(/ s-2$/, "/s²");
}

/** zartigl particle settings, as in catalog `defaults.particles`. */
export interface ParticleSettings {
  /** Particles per device pixel. */
  density: number;
  /** Multiplier of the demo base speed. */
  speed: number;
  /** Trail length, 0–1. */
  fade: number;
}

const DEFAULT_PARTICLES: ParticleSettings = {
  density: 0.033,
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

/** Css px per frame at the top of the speed range, at speed = 1. */
const BASE_SPEED = 1.6;
const MAX_PARTICLES = 256 * 256;
/** Trail segments at fade 0 and 1; geometric in between, as zartigl. */
const SEGMENTS_MIN = 8;
const SEGMENTS_MAX = 31;

/** Drawn particle count, trail segments and speed for a device-pixel canvas. */
export function particleBudget(
  settings: ParticleSettings,
  widthPx: number,
  heightPx: number,
): { count: number; segments: number; speed: number } {
  const fade = Math.max(0, Math.min(1, settings.fade));
  return {
    count: Math.max(
      1,
      Math.min(
        MAX_PARTICLES,
        Math.round(widthPx * heightPx * settings.density),
      ),
    ),
    segments: Math.round(SEGMENTS_MIN * (SEGMENTS_MAX / SEGMENTS_MIN) ** fade),
    speed: BASE_SPEED * settings.speed,
  };
}
