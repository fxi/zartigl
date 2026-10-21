import { parseLayerStyle, type LayerStyleInput } from "../catalog";
import { findLayer, layerPalettes } from "./layers";
import { findPreset } from "./presets";
import {
  SPEEDS,
  STYLE_SUPPORT,
  isTintEntry,
  type Projversor,
} from "./Projversor";
import type { ShareState } from "./share";

/**
 * A story view, as `@fxi/zartigl/story` defines it. Declared here so this
 * entry stays independent: the adapter fits the story registry structurally.
 */
export interface ProjversorViewDefinition {
  id: string;
  config: Record<string, unknown>;
}

/** How time moves in a projversor view. */
export interface ProjversorViewPlayback {
  /**
   * Playback multiplier, one of {@link SPEEDS} for the layer kind. On a
   * vector layer it also scales the particles: see `particleSpeedFactor`.
   */
  speed?: number;
  /** ISO date of the playhead; the latest month when omitted. */
  time?: string;
}

/** `config` of a `projversor` view, as {@link parseProjversorView} returns it. */
export interface ProjversorViewConfig {
  /** projversor layer id (catalog alias, or a tinted pairing id). */
  layer: string;
  preset: string;
  rotate?: [number, number, number];
  zoom?: number;
  /** Scalar entry id coloring the particles; "" colors them by speed. */
  tint?: string;
  /**
   * Style over the layer's own: `palette`, `particles` (density, speed, fade,
   * grade) on vector layers, `raster` (opacity, vibrance). Each view starts
   * from the layer's style, so an override never leaks into the next view.
   */
  style?: LayerStyleInput;
  playback?: ProjversorViewPlayback;
  /** Projection morph duration from the previous scene. */
  transitionMs?: number;
  /** Side layouts: the paragraph follows the globe limb. */
  wrap?: boolean;
}

const KEYS = new Set([
  "layer",
  "preset",
  "rotate",
  "zoom",
  "tint",
  "style",
  "playback",
  "transitionMs",
  "wrap",
]);

/** Flat keys of the first view format, and where they moved. */
const LEGACY_KEYS: Record<string, string> = {
  palette: "style.palette",
  vibrant: 'style.particles.grade ("vibrant")',
  speed: "playback.speed",
  time: "playback.time",
};

const warned = new Set<string>();

function warnLegacy(key: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(
      `projversor view config.${key} is deprecated: use ${LEGACY_KEYS[key]}`,
    );
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `moved` keys that are defined, under `target`, whose keys win. A target
 * that is not an object stays as is, for validation to reject.
 */
function under(target: unknown, moved: Record<string, unknown>): unknown {
  if (target !== undefined && !isObject(target)) {
    return target;
  }
  const merged = {
    ...Object.fromEntries(
      Object.entries(moved).filter(([, value]) => value !== undefined),
    ),
    ...target,
  };
  return Object.keys(merged).length ? merged : undefined;
}

/** Move the first format's flat keys to `style` and `playback`. */
function migrateLegacy(
  config: Record<string, unknown>,
  path: string,
  kind: "scalar" | "vector",
): Record<string, unknown> {
  const legacy = Object.keys(config).filter((key) => key in LEGACY_KEYS);
  if (!legacy.length) {
    return config;
  }
  const { palette, vibrant, speed, time, ...rest } = config;
  legacy.forEach(warnLegacy);
  invariant(
    vibrant === undefined || typeof vibrant === "boolean",
    `${path}.vibrant must be a boolean`,
  );
  const style = under(rest.style, { palette });
  // The grade colors particles: the first format ignored it on scalar layers.
  const particles =
    vibrant && kind === "vector"
      ? under(isObject(style) ? style.particles : undefined, {
          grade: "vibrant",
        })
      : undefined;
  return {
    ...rest,
    style:
      particles !== undefined && (style === undefined || isObject(style))
        ? { ...style, particles }
        : style,
    playback: under(rest.playback, { speed, time }),
  };
}

/**
 * Validate a view's config against the projversor layers and presets. The
 * flat `palette`, `vibrant`, `speed` and `time` of the first format are
 * moved to `style` and `playback`, with a one-time deprecation warning.
 */
export function parseProjversorView(
  view: ProjversorViewDefinition,
): ProjversorViewConfig {
  const path = `views.${view.id}.config`;
  const layer = findLayer(String(view.config.layer));
  invariant(layer, `${path}.layer is not a projversor layer`);
  const config = migrateLegacy(view.config, path, layer.kind);
  for (const key of Object.keys(config)) {
    invariant(KEYS.has(key), `${path}.${key} is not a projversor view key`);
  }
  invariant(findPreset(String(config.preset)), `${path}.preset is unknown`);
  if (config.rotate !== undefined) {
    invariant(
      Array.isArray(config.rotate) &&
        config.rotate.length === 3 &&
        config.rotate.every(isFiniteNumber),
      `${path}.rotate must be three numbers`,
    );
  }
  for (const key of ["zoom", "transitionMs"] as const) {
    if (config[key] !== undefined) {
      invariant(
        isFiniteNumber(config[key]) && config[key] > 0,
        `${path}.${key} must be positive`,
      );
    }
  }
  if (config.style !== undefined) {
    const style = parseLayerStyle(config.style, `${path}.style`, {
      kind: layer.kind,
      supports: STYLE_SUPPORT,
    });
    invariant(
      style.palette === undefined ||
        layerPalettes(layer).some((p) => p.id === style.palette),
      `${path}.style.palette is not offered for this layer`,
    );
  }
  if (config.playback !== undefined) {
    const playback = config.playback;
    invariant(isObject(playback), `${path}.playback must be an object`);
    for (const key of Object.keys(playback)) {
      invariant(
        key === "speed" || key === "time",
        `${path}.playback.${key} is not a playback key`,
      );
    }
    invariant(
      playback.speed === undefined ||
        SPEEDS[layer.kind].includes(playback.speed as number),
      `${path}.playback.speed must be one of ${SPEEDS[layer.kind].join(", ")}`,
    );
    invariant(
      playback.time === undefined ||
        (typeof playback.time === "string" &&
          Number.isFinite(Date.parse(playback.time))),
      `${path}.playback.time is not a date`,
    );
  }
  if (config.tint !== undefined) {
    invariant(
      layer.kind === "vector" &&
        (config.tint === "" || isTintEntry(String(config.tint))),
      `${path}.tint must be "" or a scalar entry id, on a vector layer`,
    );
  }
  if (config.wrap !== undefined) {
    invariant(
      typeof config.wrap === "boolean",
      `${path}.wrap must be a boolean`,
    );
  }
  return config as unknown as ProjversorViewConfig;
}

/**
 * The projversor state a view config shows. `style` is always set, so a view
 * without an override returns to the layer's own style, grade included.
 */
export function projversorState(
  config: ProjversorViewConfig,
): Partial<ShareState> & { style: LayerStyleInput } {
  const { style = {}, playback = {} } = config;
  return {
    layer: config.layer,
    preset: config.preset,
    rotate: config.rotate,
    zoom: config.zoom,
    tint: config.tint,
    speed: playback.speed,
    time: playback.time === undefined ? undefined : Date.parse(playback.time),
    style,
  };
}

/**
 * Story view on one persistent projversor: each scene morphs the view from
 * the previous one, and the layer reopens only when it changes.
 */
export class ProjversorStoryView {
  /**
   * @param animate Morph between views; off for still frames and reduced
   *   motion, where each view is shown at once.
   * @param onError Reports a failed time seek.
   */
  constructor(
    private readonly projversor: Projversor,
    private readonly animate = true,
    private readonly onError: (error: unknown) => void = console.error,
  ) {}

  async activate(view: ProjversorViewDefinition): Promise<void> {
    const config = parseProjversorView(view);
    await this.projversor.apply(projversorState(config), {
      animate: this.animate,
      durationMs: config.transitionMs,
    });
  }

  /** Warm the cache for a view shown next. */
  preload(view: ProjversorViewDefinition): Promise<void> {
    const { layer, playback } = parseProjversorView(view);
    const at =
      playback?.time === undefined ? undefined : Date.parse(playback.time);
    return this.projversor.preload(layer, at);
  }

  play(): void {
    this.projversor.setPlaying(true);
  }

  pause(): void {
    this.projversor.setPlaying(false);
  }

  setTime(time: number): void {
    this.projversor.seek(time).catch(this.onError);
  }

  destroy(): void {
    this.projversor.destroy();
  }
}
