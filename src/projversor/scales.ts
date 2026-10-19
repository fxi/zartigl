import { resolveColorRamp } from "../engine";

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

/** Longest span marked by day, then by month; longer ones are marked by year. */
const DAY_TICKS_MAX = 62 * DAY_MS;
const MONTH_TICKS_MAX = 915 * DAY_MS;
/** Steps from which the playhead drops its hour, then its day. */
const MONTHLY_STEP = 27 * DAY_MS;

export interface TimeTick {
  label: string;
  position: number;
  major: boolean;
}

const monthName = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

/**
 * UTC marks as positions along [first, last], at a unit fitting the span:
 * days (the 1st and every 5th major) up to two months, months (quarters
 * major, January labelled with its year) up to two and a half years, else
 * years (every one major, every 5th past twelve years).
 */
export function timeTicks(first: number, last: number): TimeTick[] {
  const ticks: TimeTick[] = [];
  const at = (t: number, label: string, major: boolean) =>
    ticks.push({ label, position: (t - first) / (last - first), major });
  const span = last - first;
  if (span <= DAY_TICKS_MAX) {
    for (let t = Math.ceil(first / DAY_MS) * DAY_MS; t <= last; t += DAY_MS) {
      const date = new Date(t).getUTCDate();
      at(t, String(date).padStart(2, "0"), date === 1 || date % 5 === 0);
    }
    return ticks;
  }
  const start = new Date(first);
  let year = start.getUTCFullYear();
  if (span <= MONTH_TICKS_MAX) {
    let month = start.getUTCMonth();
    for (
      let t = Date.UTC(year, month);
      t <= last;
      t = Date.UTC(year, ++month)
    ) {
      if (t >= first) {
        const m = new Date(t).getUTCMonth();
        at(
          t,
          m === 0 ? String(new Date(t).getUTCFullYear()) : monthName(t),
          m % 3 === 0,
        );
      }
    }
    return ticks;
  }
  const every = span > 12 * 365 * DAY_MS ? 5 : 1;
  for (let t = Date.UTC(year); t <= last; t = Date.UTC(++year)) {
    if (t >= first) {
      at(t, String(year), year % every === 0);
    }
  }
  return ticks;
}

/**
 * Chunk picker label, as short as a month one: "Sep ’26" for a chunk of a
 * month at most, else the years its samples cover, "’20–’26".
 */
export function chunkLabel(start?: string, end?: string): string {
  if (!start) {
    return "—";
  }
  const s = Date.parse(start);
  const e = Date.parse(end ?? start);
  const year = (ms: number) =>
    `’${String(new Date(ms).getUTCFullYear()).slice(2)}`;
  if (!(e - s > 31 * DAY_MS)) {
    return `${monthName(s)} ${year(s)}`;
  }
  const first = new Date(s).getUTCFullYear();
  const last = new Date(e).getUTCFullYear();
  return last === first ? String(first) : `${year(s)}–${year(e)}`;
}

/**
 * Playhead date and hour on a timeline stepping `stepMs`: the hour only
 * below daily steps (else ""), the day only below monthly ones.
 */
export function playheadLabel(
  ms: number,
  stepMs: number,
): { date: string; hour: string } {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const day =
    stepMs >= MONTHLY_STEP
      ? monthName(ms)
      : date.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        });
  return {
    date: `${day} ${year}`.toUpperCase(),
    hour:
      stepMs >= DAY_MS
        ? ""
        : `${String(date.getUTCHours()).padStart(2, "0")}:00 UTC`,
  };
}

/** The colored quantity of a month: its range, unit and ramp. */
export interface LegendScale {
  min: number;
  max: number;
  unit: string;
  /** Linear over a scalar domain; square root over a particle speed. */
  ramp: "linear" | "sqrt";
}

interface LegendField {
  readonly vector: boolean;
  readonly domain: [number, number];
  readonly maxSpeed: number;
  readonly manifest: { style: { unit?: string } };
}

/**
 * What the colors of a month mean: the raster of a scalar layer, else the
 * tint coloring the particles, over its domain; else the particle speed.
 */
export function monthLegend(month: {
  field: LegendField;
  tint: LegendField | null;
}): LegendScale {
  const { field, tint } = month;
  const scalar = field.vector ? tint : field;
  if (scalar) {
    const [min, max] = scalar.domain;
    return {
      min,
      max,
      unit: formatUnit(scalar.manifest.style.unit),
      ramp: "linear",
    };
  }
  return {
    min: 0,
    max: field.maxSpeed,
    unit: formatUnit(field.manifest.style.unit),
    ramp: "sqrt",
  };
}

/**
 * Legend ends rounded to the precision of their range (about a hundredth of
 * it), so a domain of 0.00000537–0.665 reads "0" and "0.67".
 */
export function legendLabels(
  min: number,
  max: number,
  locale = "en",
): [string, string] {
  const span = Math.abs(max - min) || Math.abs(max) || 1;
  const digits = Math.min(6, Math.max(0, 1 - Math.floor(Math.log10(span))));
  const format = new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
  });
  // Rounding must not show "-0".
  const text = (value: number) => format.format(value).replace(/^[-−]0$/, "0");
  return [text(min), text(max)];
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

/** Projversor defaults, then the catalog entry defaults, then the layer override. */
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
