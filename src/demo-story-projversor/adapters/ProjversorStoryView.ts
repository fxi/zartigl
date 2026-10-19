import { COLOR_GRADE_OFF, COLOR_GRADE_VIBRANT } from "../../engine";
import {
  findLayer,
  findPreset,
  isTintEntry,
  layerPalettes,
  SPEEDS,
  type Projversor,
  type ShareState,
} from "../../projversor";
import type {
  StoryScene,
  StoryViewAdapter,
  StoryViewDefinition,
} from "../../story";

/** `config` of a `projversor` view, validated by {@link parseProjversorView}. */
export interface ProjversorViewConfig {
  /** projversor layer id (catalog alias, or a tinted pairing id). */
  layer: string;
  preset: string;
  rotate?: [number, number, number];
  zoom?: number;
  palette?: string;
  /** Scalar entry id coloring the particles; "" colors them by speed. */
  tint?: string;
  speed?: number;
  /** ISO date of the playhead; the latest month when omitted. */
  time?: string;
  /** Projection morph duration from the previous scene. */
  transitionMs?: number;
  /** Vibrant particle color grade. */
  vibrant?: boolean;
  /** Side layouts: the paragraph follows the globe limb. */
  wrap?: boolean;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Validate a view's config against the projversor layers and presets. */
export function parseProjversorView(
  view: StoryViewDefinition,
): ProjversorViewConfig {
  const config = view.config;
  const path = `views.${view.id}.config`;
  const layer = findLayer(String(config.layer));
  invariant(layer, `${path}.layer is not a projversor layer`);
  invariant(findPreset(String(config.preset)), `${path}.preset is unknown`);
  if (config.rotate !== undefined) {
    invariant(
      Array.isArray(config.rotate) &&
        config.rotate.length === 3 &&
        config.rotate.every(isFiniteNumber),
      `${path}.rotate must be three numbers`,
    );
  }
  for (const key of ["zoom", "speed", "transitionMs"] as const) {
    if (config[key] !== undefined) {
      invariant(
        isFiniteNumber(config[key]) && config[key] > 0,
        `${path}.${key} must be positive`,
      );
    }
  }
  if (config.speed !== undefined) {
    invariant(
      SPEEDS[layer.kind].includes(Number(config.speed)),
      `${path}.speed must be one of ${SPEEDS[layer.kind].join(", ")}`,
    );
  }
  if (config.palette !== undefined) {
    invariant(
      layerPalettes(layer).some((p) => p.id === config.palette),
      `${path}.palette is not offered for this layer`,
    );
  }
  if (config.tint !== undefined) {
    invariant(
      layer.kind === "vector" &&
        (config.tint === "" || isTintEntry(String(config.tint))),
      `${path}.tint must be "" or a scalar entry id, on a vector layer`,
    );
  }
  if (config.time !== undefined) {
    invariant(
      Number.isFinite(Date.parse(String(config.time))),
      `${path}.time is not a date`,
    );
  }
  for (const key of ["vibrant", "wrap"] as const) {
    if (config[key] !== undefined) {
      invariant(
        typeof config[key] === "boolean",
        `${path}.${key} must be a boolean`,
      );
    }
  }
  return config as unknown as ProjversorViewConfig;
}

/** The projversor state a view config shows. */
export function projversorState(
  config: ProjversorViewConfig,
): Partial<ShareState> {
  return {
    layer: config.layer,
    preset: config.preset,
    rotate: config.rotate,
    zoom: config.zoom,
    palette: config.palette,
    tint: config.tint,
    speed: config.speed,
    time: config.time === undefined ? undefined : Date.parse(config.time),
    grade: config.vibrant ? COLOR_GRADE_VIBRANT : COLOR_GRADE_OFF,
  };
}

/**
 * Story view on one persistent projversor: each scene morphs the view from
 * the previous one, and the layer reopens only when it changes.
 */
export class ProjversorStoryView implements StoryViewAdapter {
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

  async activate(view: StoryViewDefinition, _scene: StoryScene): Promise<void> {
    const config = parseProjversorView(view);
    await this.projversor.apply(projversorState(config), {
      animate: this.animate,
      durationMs: config.transitionMs,
    });
  }

  /** Warm the cache for a view shown next. */
  preload(view: StoryViewDefinition): Promise<void> {
    const config = parseProjversorView(view);
    const at = config.time === undefined ? undefined : Date.parse(config.time);
    return this.projversor.preload(config.layer, at);
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
