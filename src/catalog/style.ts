/**
 * Layer style: how a layer looks, with the same keys in the catalog
 * `defaults`, the engines and story views. Playback (how time moves) is not
 * part of it, so `particles.speed` is always the particle speed.
 */

import { COLOR_GRADE_RANGES } from "../lib/color-grade";
import { BACKDROP_OFF, isHexColor, resolveBackdrop } from "../lib/backdrop";
import type { AlphaFadeCurve } from "../lib/gl-util";

export type { AlphaFadeCurve };
export type StyleRenderMode = "particles" | "raster" | "raster+particles";
/** Vibrant grade values; each one left out takes the vibrant preset's. */
export interface GradeTuning {
  /** Mid-tone lift [0, 4]. */
  exposure?: number;
  /** S-curve strength [0, 1]. */
  contrast?: number;
  /** Vibrance-weighted saturation [-1, 1]. */
  saturation?: number;
  /** Push of the bright half toward white [0, 1]. */
  highlights?: number;
}
/** Particle trail color grade: a preset, or the vibrant one tuned. */
export type ParticleGrade = "off" | "vibrant" | GradeTuning;

export interface ParticleStyle {
  /** Particles per device pixel, (0, 0.2]. */
  density: number;
  /** Css px per frame for the fastest value of the field, (0, 10]. */
  speed: number;
  /** Trail length, [0, 1] (longer when higher). */
  fade: number;
  /** Trail color grade; replaced as a whole, not merged. */
  grade: ParticleGrade;
  /** Solid color under the trails; replaced as a whole, not merged. */
  backdrop: BackdropStyle;
}

/** Partial particle style; a partial backdrop takes the defaults' keys. */
export type ParticleStyleInput = Partial<Omit<ParticleStyle, "backdrop">> & {
  backdrop?: Partial<BackdropStyle>;
};

export interface RasterStyle {
  opacity: number;
  logScale: boolean;
  /** Vibrance adjustment, [-1, 1]. */
  vibrance: number;
  /** Fixed physical-value domain; null follows the data. */
  colorDomain: [number, number] | null;
  /**
   * Fraction of the color range, from its low end, over which colors fade in
   * from transparent, [0, 1]: a field that is mostly zero (fires, heat
   * stress) shows only where something happens. Values below the domain are
   * transparent too.
   */
  alphaFadeLow: number;
  /** Fraction of the color range, from its high end, fading out, [0, 1]. */
  alphaFadeHigh: number;
  /** Shape of both fades: "log" rises fast, "exp" stays faint longer. */
  alphaFadeCurve: AlphaFadeCurve;
}

/**
 * Solid color under the particle trails, drawn on valid data cells only: it
 * keeps particles readable over a light basemap. Off by default; an object
 * without `enabled` is on.
 */
export interface BackdropStyle {
  enabled: boolean;
  /** Hex color, `#rgb` or `#rrggbb`. */
  color: string;
  opacity: number;
}

export interface LayerStyle {
  /** Palette id; undefined lets the engine pick its own. */
  palette?: string;
  /** Run the palette from its last color to its first, for raster and particles. */
  reversePalette: boolean;
  renderMode: StyleRenderMode;
  particles: ParticleStyle;
  raster: RasterStyle;
}

/** A partial style: any key left out takes the value below it. */
export interface LayerStyleInput {
  palette?: string;
  reversePalette?: boolean;
  renderMode?: StyleRenderMode;
  particles?: ParticleStyleInput;
  raster?: Partial<RasterStyle>;
}

/** Engine fallbacks, under the catalog `defaults`. */
export const LAYER_STYLE_DEFAULTS: Readonly<LayerStyle> = Object.freeze({
  reversePalette: false,
  renderMode: "particles",
  particles: Object.freeze({
    density: 0.05,
    speed: 1,
    fade: 0.7,
    grade: "off",
    backdrop: BACKDROP_OFF,
  }),
  raster: Object.freeze({
    opacity: 1,
    logScale: false,
    vibrance: 0,
    colorDomain: null,
    alphaFadeLow: 0,
    alphaFadeHigh: 0,
    alphaFadeCurve: "linear",
  }),
}) as LayerStyle;

/** Style groups: objects merged key by key. */
const GROUPS = ["particles", "raster"] as const;

const defined = <T extends object>(value: T | undefined): Partial<T> =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;

/**
 * Palettes replaced by a palette plus style keys. `heat-alert` faded its
 * lowest values in through alpha stops; `raster.alphaFadeLow` now does that
 * with any palette (0.25, linear, fits its alpha within 0.04 RMS).
 */
const LEGACY_PALETTES: Record<
  string,
  { palette: string; raster: Partial<RasterStyle> }
> = {
  "heat-alert": { palette: "heat", raster: { alphaFadeLow: 0.25 } },
};

/**
 * `input` with legacy palettes rewritten, so old catalogs, share links and
 * story views keep their look. Keys the input sets itself win.
 */
export function migrateLegacyStyle(input: LayerStyleInput): LayerStyleInput;
export function migrateLegacyStyle(
  input: LayerStyleInput | undefined,
): LayerStyleInput | undefined;
export function migrateLegacyStyle(
  input: LayerStyleInput | undefined,
): LayerStyleInput | undefined {
  const legacy = input?.palette ? LEGACY_PALETTES[input.palette] : undefined;
  if (!input || !legacy) {
    return input;
  }
  return {
    ...input,
    palette: legacy.palette,
    raster: { ...legacy.raster, ...input.raster },
  };
}

/**
 * Merge styles over {@link LAYER_STYLE_DEFAULTS}, later inputs winning key by
 * key. Usual order: catalog `defaults`, engine style, view.
 */
export function resolveLayerStyle(
  ...inputs: (LayerStyleInput | undefined)[]
): LayerStyle {
  const style: LayerStyle = {
    reversePalette: LAYER_STYLE_DEFAULTS.reversePalette,
    renderMode: LAYER_STYLE_DEFAULTS.renderMode,
    particles: { ...LAYER_STYLE_DEFAULTS.particles },
    raster: { ...LAYER_STYLE_DEFAULTS.raster },
  };
  for (const raw of inputs) {
    const input = migrateLegacyStyle(raw);
    if (!input) {
      continue;
    }
    if (input.palette !== undefined) {
      style.palette = input.palette;
    }
    if (input.reversePalette !== undefined) {
      style.reversePalette = input.reversePalette;
    }
    if (input.renderMode !== undefined) {
      style.renderMode = input.renderMode;
    }
    Object.assign(style.particles, defined(input.particles));
    Object.assign(style.raster, defined(input.raster));
  }
  const { grade, backdrop } = style.particles;
  if (typeof grade === "object") {
    style.particles.grade = { ...grade };
  }
  style.particles.backdrop = resolveBackdrop(backdrop);
  return style;
}

/**
 * One partial style from several, later inputs winning key by key: patch an
 * override without resolving defaults.
 */
export function mergeStyles(
  ...inputs: (LayerStyleInput | undefined)[]
): LayerStyleInput {
  const merged: LayerStyleInput = {};
  for (const raw of inputs) {
    const input = migrateLegacyStyle(raw);
    if (!input) {
      continue;
    }
    if (input.palette !== undefined) {
      merged.palette = input.palette;
    }
    if (input.reversePalette !== undefined) {
      merged.reversePalette = input.reversePalette;
    }
    if (input.renderMode !== undefined) {
      merged.renderMode = input.renderMode;
    }
    for (const group of GROUPS) {
      const values = defined(input[group]);
      if (Object.keys(values).length) {
        merged[group] = { ...merged[group], ...values } as never;
      }
    }
  }
  return merged;
}

/** The keys of `style` whose value differs from `base`'s. */
export function diffStyle(
  style: LayerStyleInput,
  base: LayerStyle,
): LayerStyleInput {
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const diff: LayerStyleInput = {};
  if (style.palette !== undefined && style.palette !== base.palette) {
    diff.palette = style.palette;
  }
  if (
    style.reversePalette !== undefined &&
    style.reversePalette !== base.reversePalette
  ) {
    diff.reversePalette = style.reversePalette;
  }
  if (style.renderMode !== undefined && style.renderMode !== base.renderMode) {
    diff.renderMode = style.renderMode;
  }
  for (const group of GROUPS) {
    const values = Object.entries(defined(style[group])).filter(
      ([key, value]) =>
        !same(value, (base[group] as unknown as Record<string, unknown>)[key]),
    );
    if (values.length) {
      diff[group] = Object.fromEntries(values) as never;
    }
  }
  return diff;
}

/** A catalog entry, or anything with its kind and default style. */
export interface StyledEntry {
  kind: "scalar" | "vector";
  defaults?: LayerStyleInput;
}

/** `style` without the keys a layer of `kind` cannot draw. */
export function styleForKind(
  style: LayerStyleInput,
  kind: StyledEntry["kind"] | undefined,
): LayerStyleInput {
  if (kind !== "scalar") {
    return style;
  }
  const { particles: _particles, renderMode, ...rest } = style;
  return renderMode === "raster" ? { ...rest, renderMode } : rest;
}

/**
 * The style a catalog layer is drawn with: its own style, then `inputs`.
 * Scalar layers draw a raster.
 */
export function resolveEntryStyle(
  entry: StyledEntry | undefined,
  ...inputs: (LayerStyleInput | undefined)[]
): LayerStyle {
  const style = resolveLayerStyle(entry?.defaults, ...inputs);
  if (entry?.kind === "scalar") {
    style.renderMode = "raster";
  }
  return style;
}

/** Which keys a caller supports, and for which layer kind. */
export interface ParseLayerStyleOptions {
  kind?: "scalar" | "vector";
  /** Keys left out are rejected as unsupported; all when omitted. */
  supports?: {
    palette?: boolean;
    renderMode?: boolean;
    particles?: readonly (keyof ParticleStyle)[];
    raster?: readonly (keyof RasterStyle)[];
  };
  /**
   * Keys that are not style keys at all: "throw" (default), or "drop" them
   * with a warning, so a style written for a newer engine still renders with
   * an older one. Invalid values of known keys always throw.
   */
  unknownKeys?: "throw" | "drop";
  /** Where dropped keys are reported; console.warn by default. */
  warn?: (message: string) => void;
}

/** What parseGroup and parseLayerStyle do with a key that is not a style key. */
type Unknown = (at: string) => void;

const RENDER_MODES: StyleRenderMode[] = [
  "particles",
  "raster",
  "raster+particles",
];
const GRADES: ParticleGrade[] = ["off", "vibrant"];
const ALPHA_FADE_CURVES: AlphaFadeCurve[] = ["linear", "log", "exp"];

type Check = (value: unknown) => boolean;
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const inRange =
  (min: number, max: number, openMin = false): Check =>
  (v) =>
    isNumber(v) && (openMin ? v > min : v >= min) && v <= max;

const PARTICLE_CHECKS: Record<keyof ParticleStyle, [Check, string]> = {
  density: [inRange(0, 0.2, true), "a number in (0, 0.2]"],
  speed: [inRange(0, 10, true), "a number in (0, 10]"],
  fade: [inRange(0, 1), "a number in [0, 1]"],
  grade: [
    (v) => GRADES.includes(v as ParticleGrade) || isGradeTuning(v),
    `"off", "vibrant" or an object of ${Object.keys(COLOR_GRADE_RANGES).join(", ")} in range`,
  ],
  backdrop: [
    (v) => isBackdrop(v),
    'an object of enabled (a boolean), color ("#rgb" or "#rrggbb") and opacity (a number in [0, 1])',
  ],
};
const RASTER_CHECKS: Record<keyof RasterStyle, [Check, string]> = {
  opacity: [inRange(0, 1), "a number in [0, 1]"],
  logScale: [(v) => typeof v === "boolean", "a boolean"],
  vibrance: [inRange(-1, 1), "a number in [-1, 1]"],
  colorDomain: [
    (v) =>
      v === null ||
      (Array.isArray(v) && v.length === 2 && v.every(isNumber) && v[0] < v[1]),
    "null or [min, max] with min < max",
  ],
  alphaFadeLow: [inRange(0, 1), "a number in [0, 1]"],
  alphaFadeHigh: [inRange(0, 1), "a number in [0, 1]"],
  alphaFadeCurve: [
    (v) => ALPHA_FADE_CURVES.includes(v as AlphaFadeCurve),
    `one of ${ALPHA_FADE_CURVES.join(", ")}`,
  ],
};

const BACKDROP_CHECKS: Record<keyof BackdropStyle, Check> = {
  enabled: (v) => typeof v === "boolean",
  color: isHexColor,
  opacity: inRange(0, 1),
};

/** Style keys, for checks against other definitions of the same shape. */
export const PARTICLE_STYLE_KEYS = Object.keys(
  PARTICLE_CHECKS,
) as (keyof ParticleStyle)[];
export const RASTER_STYLE_KEYS = Object.keys(
  RASTER_CHECKS,
) as (keyof RasterStyle)[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isGradeTuning = (value: unknown): boolean =>
  isObject(value) &&
  Object.entries(value).every(([key, item]) => {
    const range = Object.prototype.hasOwnProperty.call(COLOR_GRADE_RANGES, key)
      ? COLOR_GRADE_RANGES[key as keyof GradeTuning]
      : undefined;
    return range !== undefined && inRange(range[0], range[1])(item);
  });

const isBackdrop = (value: unknown): boolean =>
  isObject(value) &&
  Object.entries(value).every(
    ([key, item]) =>
      Object.prototype.hasOwnProperty.call(BACKDROP_CHECKS, key) &&
      BACKDROP_CHECKS[key as keyof BackdropStyle](item),
  );

function fail(message: string): never {
  throw new Error(message);
}

function parseGroup<K extends string>(
  value: unknown,
  path: string,
  checks: Record<K, [Check, string]>,
  supported: readonly K[] | undefined,
  unknown: Unknown,
): Partial<Record<K, unknown>> {
  if (!isObject(value)) {
    fail(`${path} must be an object`);
  }
  const parsed: Partial<Record<K, unknown>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(checks, key)) {
      unknown(`${path}.${key}`);
      continue;
    }
    if (supported && !supported.includes(key as K)) {
      fail(`${path}.${key} is not supported here`);
    }
    const [check, expected] = checks[key as K];
    if (!check(item)) {
      fail(`${path}.${key} must be ${expected}`);
    }
    parsed[key as K] = item;
  }
  return parsed;
}

/**
 * Validate a style, throwing an error that names the offending path, e.g.
 * `views.swell.config.style.particles.density must be a number in (0, 0.2]`.
 */
export function parseLayerStyle(
  value: unknown,
  path: string,
  options: ParseLayerStyleOptions = {},
): LayerStyleInput {
  const { kind, supports, unknownKeys = "throw" } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const unknown: Unknown = (at) => {
    if (unknownKeys === "throw") {
      fail(`${at} is not a style key`);
    }
    warn(`${at} is not a style key of this zartigl version: ignored`);
  };
  if (!isObject(value)) {
    fail(`${path} must be an object`);
  }
  const parsed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const at = `${path}.${key}`;
    switch (key) {
      case "palette":
        if (supports && !supports.palette) {
          fail(`${at} is not supported here`);
        }
        if (typeof item !== "string" || !item) {
          fail(`${at} must be a string`);
        }
        break;
      case "reversePalette":
        if (supports && !supports.palette) {
          fail(`${at} is not supported here`);
        }
        if (typeof item !== "boolean") {
          fail(`${at} must be a boolean`);
        }
        break;
      case "renderMode":
        if (supports && !supports.renderMode) {
          fail(`${at} is not supported here`);
        }
        if (!RENDER_MODES.includes(item as StyleRenderMode)) {
          fail(`${at} must be one of ${RENDER_MODES.join(", ")}`);
        }
        if (kind === "scalar" && item !== "raster") {
          fail(`${at} must be "raster" on a scalar layer`);
        }
        break;
      case "particles":
        if (kind === "scalar") {
          fail(`${at} needs a vector layer`);
        }
        parsed[key] = parseGroup(
          item,
          at,
          PARTICLE_CHECKS,
          supports && (supports.particles ?? []),
          unknown,
        );
        continue;
      case "raster":
        parsed[key] = parseGroup(
          item,
          at,
          RASTER_CHECKS,
          supports && (supports.raster ?? []),
          unknown,
        );
        continue;
      default:
        unknown(at);
        continue;
    }
    parsed[key] = item;
  }
  return migrateLegacyStyle(parsed as LayerStyleInput);
}
