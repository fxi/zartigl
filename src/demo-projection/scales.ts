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

/** "m s-1" → "m/s", "degrees_C" → "°C". */
export function formatUnit(unit: string | undefined): string {
  if (unit === "degrees_C" || unit === "degC") {
    return "°C";
  }
  return (unit ?? "").replace(/ s-1$/, "/s").replace(/ s-2$/, "/s²");
}

/**
 * Round values (1, 2, 2.5 or 5 × 10ⁿ apart, about five intervals) within
 * [min, max], with their linear position on the ramp.
 */
export function linearTicks(
  min: number,
  max: number,
): { value: number; position: number }[] {
  const raw = (max - min) / 5;
  const decade = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10]
    .map((n) => n * decade)
    .reduce((best, s) =>
      Math.abs(Math.log(s / raw)) < Math.abs(Math.log(best / raw)) ? s : best,
    );
  const ticks: { value: number; position: number }[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    const value = Number(v.toPrecision(6));
    ticks.push({ value, position: (value - min) / (max - min) });
  }
  return ticks;
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

/** Playback speeds and the particle speed factor at each end. */
const PLAYBACK_RANGE: [number, number] = [0.5, 5];
const PARTICLE_RANGE: [number, number] = [0.2, 1];

/**
 * Particle speed factor for a playback speed: log-log interpolation from
 * 0.5× → 0.2 to 5× → 1, so the fastest playback moves particles at their
 * natural speed and slower playback slows them gently.
 */
export function particleSpeedFactor(playback: number): number {
  const [p0, p1] = PLAYBACK_RANGE;
  const [f0, f1] = PARTICLE_RANGE;
  const t = Math.log(playback / p0) / Math.log(p1 / p0);
  return f0 * (f1 / f0) ** t;
}
