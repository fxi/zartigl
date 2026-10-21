import { easeCubicInOut, geoPath } from "d3";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land110 from "world-atlas/land-110m.json";
import {
  mergeStyles,
  parseLayerStyle,
  requireCatalogEntry,
  resolveEntryStyle,
  resolveLayerStyle,
  styleForKind,
  sourceCoversTime,
  type CatalogGeoVideoSource,
  type LayerStyle,
  type LayerStyleInput,
} from "../catalog";
import {
  COLOR_GRADE_OFF,
  TrailFade,
  colorGradeToGrade,
  gradeToColorGrade,
  createColorRampTexture,
  fadeToFrames,
  fadeToOpacity,
  loadGeoVideoManifest,
  pairChunk,
  type ColorGrade,
} from "../engine";
import {
  rotationBearing,
  screenNorth,
  withBearing,
  type ScreenProjection,
} from "./bearing";
import { GeoVideoField } from "./GeoVideoField";
import {
  PROJVERSOR_LAYERS,
  TINT_LAYERS,
  findLayer,
  layerPalettes,
  loadChunks,
  loadTintChunks,
  type ProjversorLayer,
} from "./layers";
import { Overlay } from "./Overlay";
import { PRESETS, findPreset, type Preset } from "./presets";
import { PROJECTIONS, cartesian, fitScale } from "./projections";
import { particleCount, particleSpeedFactor } from "./scales";
import type { LegacyShareState, ShareState } from "./share";
import {
  SphereParticles,
  visibleCap,
  type ParticleStyle,
} from "./SphereParticles";
import { SphereScalar } from "./SphereScalar";
import {
  interpolateRotation,
  versor,
  versorDelta,
  versorMultiply,
  versorRotation,
} from "./versor";
import {
  NO_INSET,
  lerpInset,
  regionView,
  viewArea,
  viewFrame,
  type Inset,
  type View,
  type ViewFrame,
} from "./view";

type Rotate = [number, number, number];

/** Field time steps played per second at 1×. */
const STEPS_PER_SECOND = 0.4;

/** Style keys projversor renders. */
export const STYLE_SUPPORT = {
  palette: true,
  particles: ["density", "speed", "fade", "grade"],
  raster: ["opacity", "vibrance"],
} as const;

const warned = new Set<string>();

/**
 * The deprecated flat `palette` and `grade` of a state, as a style, with a
 * one-time warning each.
 */
function legacyStyle(state: LegacyShareState): LayerStyleInput | undefined {
  const { palette, grade } = state;
  const moved = { palette: "style.palette", grade: "style.particles.grade" };
  for (const key of ["palette", "grade"] as const) {
    if (state[key] !== undefined && !warned.has(key)) {
      warned.add(key);
      console.warn(`projversor state.${key} is deprecated: use ${moved[key]}`);
    }
  }
  return palette === undefined && grade === undefined
    ? undefined
    : mergeStyles({
        palette,
        particles: { grade: grade && colorGradeToGrade(grade) },
      });
}

/** Validate a style against what projversor renders for `layer`. */
function checkStyle(
  style: LayerStyleInput | undefined,
  layer: ProjversorLayer,
): void {
  if (style !== undefined) {
    parseLayerStyle(style, "style", {
      kind: layer.kind,
      supports: STYLE_SUPPORT,
    });
  }
}

/**
 * Playback speeds and defaults per layer kind: particles need slow steps to
 * keep stable trails, while a raster only shows change when played faster.
 */
export const SPEEDS: Record<ProjversorLayer["kind"], number[]> = {
  vector: [0.5, 1, 2, 5],
  scalar: [1, 2, 5, 10, 20],
};
const DEFAULT_SPEEDS: Record<ProjversorLayer["kind"], number> = {
  vector: 1,
  scalar: 5,
};
/** Projection morph duration. */
export const TRANSITION_MS = 2200;
/** Easing of compass, zoom and rotate controls. */
export const VIEW_MS = 450;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 200;
/** Bearings below this (degrees) open locked north up. */
const NORTH_EPSILON = 0.5;
/** Fraction of a month after which the next one is decoded. */
const PREFETCH_AT = 0.6;
/** zartigl particle respawn: per frame, plus per m/s of local speed. */
const DROP_RATE = 0.003;
const DROP_RATE_BUMP = 0.01;
/**
 * zartigl's REDISTRIB_*: a transient drop-rate boost after a view change, so
 * particles spread over the new view instead of lingering in the old one.
 */
const REDISTRIB_DECAY = 0.92;
const REDISTRIB_MAX_DROP = 0.1;
/** The camera counts as moving until its view rests this long. */
const MOVE_SETTLE_MS = 100;
/** Frames still animated while paused, to rebuild trails after a change. */
const SETTLE_FRAMES_MAX = 120;

/** The fields of one month: the layer field and its optional tint. */
export interface ProjversorMonth {
  field: GeoVideoField;
  tint: GeoVideoField | null;
}

function destroyMonth(month: ProjversorMonth): void {
  month.field.destroy();
  month.tint?.destroy();
}

interface Upcoming {
  index: number;
  month: ProjversorMonth | null;
}

/** The stage and its three stacked canvases: land below, GL, lines above. */
export interface ProjversorCanvases {
  stage: HTMLElement;
  back: HTMLCanvasElement;
  gl: HTMLCanvasElement;
  front: HTMLCanvasElement;
}

/** Events and their payloads. */
export interface ProjversorEvents {
  status: string;
  /** A layer was chosen; its month chunks are known, not yet decoded. */
  layer: ProjversorLayer;
  /** A month was decoded and is displayed. */
  month: ProjversorMonth;
  palette: string;
  playing: boolean;
  preset: Preset;
  north: boolean;
  /** After each drawn frame. */
  frame: undefined;
}

/** View target: a preset morphs, rotate and zoom alone ease. */
export interface ProjversorViewTarget {
  preset?: string;
  rotate?: Rotate;
  zoom?: number;
  /** Free zone the sphere is centered and fitted in; eases with the view. */
  inset?: Inset;
  durationMs?: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function isTintEntry(id: string | undefined): id is string {
  return TINT_LAYERS.some((l) => l.entryId === id);
}

const landFeature = (topology: unknown) => {
  const t = topology as Topology<{ land: GeometryCollection }>;
  return feature(t, t.objects.land);
};

/**
 * GeoVideo archives on a sphere that morphs between projections: particles
 * for vector layers, a raster for scalar ones. Owns the GL context, the
 * frame loop, archive loading and the view; controls stay with the caller.
 */
export class Projversor {
  private readonly gl: WebGL2RenderingContext;
  private readonly particles: SphereParticles;
  private readonly raster: SphereScalar;
  private readonly overlay: Overlay;
  private readonly trailFade = new TrailFade(fadeToOpacity(0.7));
  private readonly listeners = new Map<string, Set<(detail: never) => void>>();
  private readonly resizer: ResizeObserver;
  private frameId = 0;
  private destroyed = false;
  /** Drop-rate boost after a view change, and the view it was measured on. */
  private redistribution = 0;
  private lastScale = 0;
  private lastCenter: Rotate = [1, 0, 0];
  /** Frames left to animate while paused. */
  private settle = 0;
  private north = true;
  private readonly speeds = { ...DEFAULT_SPEEDS };
  private paletteId = "";
  private ramp: WebGLTexture | null = null;
  private gradeValue: ColorGrade = COLOR_GRADE_OFF;
  private layerValue: ProjversorLayer = PROJVERSOR_LAYERS[0];
  private opened = false;
  private presetValue: Preset = PRESETS[0];
  private rasterOpacity = 1;
  private rasterVibrance = 0;
  private field: GeoVideoField | null = null;
  private tint: GeoVideoField | null = null;
  private tintIdValue: string | null = null;
  private tintChunks: CatalogGeoVideoSource[] = [];
  private chunksValue: CatalogGeoVideoSource[] = [];
  private chunkIndexValue = 0;
  private particleSettings: LayerStyle["particles"] =
    resolveLayerStyle().particles;
  /** Style override of the current story view, over the layer's own. */
  private viewStyle: LayerStyleInput = {};
  private upcoming: Upcoming | null = null;
  /** Bumped on every layer or month switch; stale loads drop out. */
  private loadId = 0;
  private readonly view: View;
  private dpr = 1;
  private ms = 0;
  private playingValue = true;
  private held = false;
  private pendingRespawn = false;
  private overlayKey = "";
  private lastMove = 0;
  private detailed = false;
  private last = 0;
  private insetTransition: {
    start: number;
    duration: number;
    from: Inset;
    to: Inset;
  } | null = null;
  private transition: {
    start: number;
    duration: number;
    rotate: (t: number) => Rotate;
    zoom: [number, number];
  } | null = null;
  private drag: {
    v0: Rotate;
    q0: ReturnType<typeof versor>;
    r0: Rotate;
  } | null = null;

  constructor(
    private readonly canvases: ProjversorCanvases,
    initial: Partial<ShareState> = {},
  ) {
    // Premultiplied canvas, composited with view.ts compositeBlend.
    const gl = canvases.gl.getContext("webgl2", {
      antialias: true,
      depth: true,
    });
    if (!gl) {
      throw new Error("WebGL2 is required");
    }
    this.gl = gl;
    this.particles = new SphereParticles(gl);
    this.raster = new SphereScalar(gl);
    this.overlay = new Overlay(canvases.back, canvases.front, {
      land: landFeature(land110),
    });
    // The finer coastline is ten times heavier: load it after first paint.
    import("world-atlas/land-50m.json")
      .then(({ default: land50 }) => {
        if (!this.destroyed) {
          this.overlay.setLandDetail(landFeature(land50));
          this.detailed = false;
        }
      })
      .catch(() => {});
    this.presetValue = findPreset(initial.preset) ?? PRESETS[0];
    const def = PROJECTIONS[this.presetValue.projection];
    this.view = {
      blend: { a: def, b: def, ka: 1, kb: 1, t: 0 },
      rotate: this.lockNorth(initial.rotate ?? this.presetValue.rotate),
      zoom: clampZoom(initial.zoom ?? this.presetValue.zoom),
      width: 1,
      height: 1,
    };
    this.gradeValue = gradeToColorGrade(initial.style?.particles?.grade);
    this.playingValue = initial.playing ?? true;
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(canvases.stage);
    this.resize();
    this.frameId = requestAnimationFrame((now) => this.tick(now));
  }

  // ---- events ------------------------------------------------------------

  /** Listen to an event; returns the unsubscribe function. */
  on<K extends keyof ProjversorEvents>(
    type: K,
    listener: (detail: ProjversorEvents[K]) => void,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as (detail: never) => void);
    return () => set.delete(listener as (detail: never) => void);
  }

  private emit<K extends keyof ProjversorEvents>(
    type: K,
    detail: ProjversorEvents[K],
  ): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (detail: ProjversorEvents[K]) => void)(detail);
    }
  }

  // ---- state -------------------------------------------------------------

  get layer(): ProjversorLayer {
    return this.layerValue;
  }

  /** Scalar entry id coloring the particles, or null. */
  get tintId(): string | null {
    return this.tintIdValue;
  }

  get palette(): string {
    return this.paletteId;
  }

  get grade(): ColorGrade {
    return this.gradeValue;
  }

  get preset(): Preset {
    return this.presetValue;
  }

  get playing(): boolean {
    return this.playingValue;
  }

  /** Playback speed multiplier of the open layer. */
  get speed(): number {
    return this.speeds[this.layerValue.kind];
  }

  /** Month chunks of the open layer and the displayed one. */
  get chunks(): readonly CatalogGeoVideoSource[] {
    return this.chunksValue;
  }

  get chunkIndex(): number {
    return this.chunkIndexValue;
  }

  /** Playhead, epoch ms. */
  get time(): number {
    return this.ms;
  }

  /** Frame times of the displayed month. */
  get times(): readonly number[] {
    return this.field?.times ?? [];
  }

  /** Playhead position in the displayed month, 0–1. */
  get progress(): number {
    const times = this.times;
    if (times.length < 2) {
      return 0;
    }
    return (this.ms - times[0]) / (times[times.length - 1] - times[0]);
  }

  get rotate(): Rotate {
    return this.view.rotate;
  }

  get zoom(): number {
    return this.view.zoom;
  }

  get bearing(): number {
    return rotationBearing(this.view.rotate);
  }

  /** Drags keep north up (gamma 0), as d3-geo-zoom's northUp. */
  get northLocked(): boolean {
    return this.north;
  }

  set northLocked(locked: boolean) {
    if (this.north !== locked) {
      this.north = locked;
      this.emit("north", locked);
    }
  }

  /** Everything needed to reproduce the displayed view. */
  getState(): ShareState {
    return {
      layer: this.layerValue.id,
      time: this.ms,
      preset: this.presetValue.id,
      rotate: [...this.view.rotate],
      zoom: this.view.zoom,
      playing: this.playingValue,
      speed: this.speed,
      tint: this.tintIdValue ?? "",
      style: styleForKind(this.viewStyle, this.layerValue.kind),
    };
  }

  /**
   * Show a state: unknown ids fall back to the layer's own choices. The
   * layer reopens only when it or its tint changes. A view in the state
   * keeps its own framing, else a regional layer is framed. A `style`
   * replaces the previous override over the layer's own style (`{}` clears
   * it) once the layer shows; without one, the current override stays.
   * The deprecated flat `palette` and `grade` patch it, `style` winning.
   */
  async apply(
    state: Partial<ShareState> & LegacyShareState,
    options: { animate?: boolean; durationMs?: number } = {},
  ): Promise<void> {
    const { animate = true, durationMs } = options;
    const layer =
      findLayer(state.layer) ??
      (this.opened ? this.layerValue : PROJVERSOR_LAYERS[0]);
    checkStyle(state.style, layer);
    const legacy = legacyStyle(state);
    const style =
      legacy === undefined
        ? state.style
        : styleForKind(
            state.style === undefined
              ? mergeStyles(this.viewStyle, legacy)
              : mergeStyles(legacy, state.style),
            layer.kind,
          );
    const hasView =
      state.preset !== undefined ||
      state.rotate !== undefined ||
      state.zoom !== undefined;
    if (hasView) {
      const target = { ...state, durationMs };
      if (animate) {
        this.goTo(target);
      } else {
        this.jumpTo(target);
      }
    }
    if (state.playing !== undefined) {
      this.setPlaying(state.playing);
    }
    // "" is "no tint"; unknown ids fall back to the layer's own.
    const tintOption =
      state.tint === ""
        ? null
        : isTintEntry(state.tint)
          ? state.tint
          : undefined;
    const tint =
      layer.kind === "vector"
        ? tintOption === undefined
          ? (layer.tint ?? null)
          : tintOption
        : null;
    if (
      !this.opened ||
      layer.id !== this.layerValue.id ||
      tint !== this.tintIdValue
    ) {
      await this.open(layer, {
        at: state.time,
        tint,
        speed: state.speed,
        frame: !hasView,
        style,
      });
      return;
    }
    if (style !== undefined) {
      this.restyle(style);
      const palette = this.stylePalette(layer);
      if (palette !== this.paletteId) {
        this.applyPalette(palette);
      }
    }
    this.setKindSpeed(layer.kind, state.speed);
    if (state.time !== undefined) {
      await this.seek(state.time);
    }
  }

  // ---- layers ------------------------------------------------------------

  /**
   * Switch layer, opening the month that holds `at`, else the displayed
   * month when the archive has it, else the latest. The palette is the
   * view style's, else the layer's own; the tint defaults to the layer's.
   * `frame` centers the view on a regional layer. The style applies once
   * the layer shows.
   */
  async open(
    layerOrId: ProjversorLayer | string,
    options: {
      at?: number;
      tint?: string | null;
      /** Playback speed, applied with the layer when it is one of its kind. */
      speed?: number;
      frame?: boolean;
      /** Style override replacing the current one. */
      style?: LayerStyleInput;
    } = {},
  ): Promise<void> {
    const layer =
      typeof layerOrId === "string" ? findLayer(layerOrId) : layerOrId;
    if (!layer) {
      throw new Error(`Unknown layer: ${String(layerOrId)}`);
    }
    checkStyle(options.style, layer);
    const { at, frame = true } = options;
    const tintId =
      layer.kind === "vector"
        ? options.tint === undefined
          ? (layer.tint ?? null)
          : options.tint
        : null;
    const id = ++this.loadId;
    this.dropUpcoming();
    this.setStatus(`Loading ${layer.label}…`);
    const stale = () => id !== this.loadId || this.destroyed;
    let chunks: CatalogGeoVideoSource[];
    let tintChunks: CatalogGeoVideoSource[];
    try {
      // An unreadable tint index leaves no tint chunks, not a failed layer.
      [chunks, tintChunks] = await Promise.all([
        loadChunks(layer.entryId),
        loadTintChunks(tintId),
      ]);
    } catch (error) {
      // A superseded load fails silently: another layer is on its way.
      if (stale()) {
        return;
      }
      throw error;
    }
    if (stale()) {
      return;
    }
    if (!chunks.length) {
      throw new Error(`${layer.label} has no archive months`);
    }
    const shown = this.chunksValue[this.chunkIndexValue]?.temporal?.start;
    const holding =
      at === undefined
        ? -1
        : chunks.findIndex((c) => sourceCoversTime(c, { time: at }));
    const same = chunks.findIndex((c) => c.temporal?.start === shown);
    const chunkIndex =
      holding >= 0 ? holding : same >= 0 ? same : chunks.length - 1;
    // The previous layer keeps its palette and settings until the new month
    // is decoded, then everything switches in the same frame.
    this.setStatus("Decoding…");
    let month: ProjversorMonth;
    try {
      month = await this.loadMonth(chunks[chunkIndex], at, tintChunks);
    } catch (error) {
      if (stale()) {
        return;
      }
      throw error;
    }
    if (stale()) {
      destroyMonth(month);
      return;
    }
    this.opened = true;
    this.layerValue = layer;
    this.tintIdValue = tintId;
    this.tintChunks = tintChunks;
    this.chunksValue = chunks;
    this.overlay.fillLand = layer.fillLand;
    this.overlayKey = "";
    this.restyle(options.style);
    this.setKindSpeed(layer.kind, options.speed);
    this.emit("layer", layer);
    this.applyPalette(this.stylePalette(layer));
    this.adopt(month, chunkIndex, at);
    this.pendingRespawn = true;
    const region =
      frame && this.field && id === this.loadId
        ? regionView(this.field.bounds, this.view)
        : null;
    if (region) {
      this.easeTo(region.rotate, clampZoom(region.zoom));
    }
  }

  /** Open month `index` of the open layer at its start. */
  openMonth(index: number): Promise<void> {
    const chunk = this.chunksValue[index];
    return chunk ? this.openChunk(chunk) : Promise.resolve();
  }

  /** Move the playhead, opening the month that holds `ms` when needed. */
  async seek(ms: number): Promise<void> {
    const times = this.times;
    if (times.length && ms >= times[0] && ms <= times[times.length - 1]) {
      this.scrub(ms);
      return;
    }
    const chunk = this.chunksValue.find((c) =>
      sourceCoversTime(c, { time: ms }),
    );
    if (chunk) {
      await this.openChunk(chunk, ++this.loadId, ms);
    }
  }

  /** Move the playhead within the displayed month. */
  scrub(ms: number): void {
    const field = this.field;
    if (!field || field.times.length < 2) {
      return;
    }
    const { times } = field;
    this.ms = Math.min(Math.max(ms, times[0]), times[times.length - 1]);
    field.focus(this.ms);
    this.tint?.focus(this.ms);
    this.settle = this.settleFrames();
  }

  /**
   * Warm the HTTP cache with a layer's index and the manifest of the month
   * holding `at`, so a later {@link open} starts sooner.
   */
  async preload(layerId: string, at?: number): Promise<void> {
    const layer = findLayer(layerId);
    if (!layer) {
      return;
    }
    const chunks = await loadChunks(layer.entryId);
    const chunk =
      (at === undefined
        ? undefined
        : chunks.find((c) => sourceCoversTime(c, { time: at }))) ??
      chunks[chunks.length - 1];
    if (chunk) {
      await loadGeoVideoManifest(chunk.manifestUrl);
    }
  }

  /** Open a month at `at`, or at its start. */
  private async openChunk(
    chunk: CatalogGeoVideoSource,
    id = ++this.loadId,
    at?: number,
  ): Promise<void> {
    this.dropUpcoming();
    this.setStatus("Decoding…");
    let month: ProjversorMonth;
    try {
      month = await this.loadMonth(chunk, at);
    } catch (error) {
      if (id !== this.loadId || this.destroyed) {
        return;
      }
      throw error;
    }
    if (id !== this.loadId || this.destroyed) {
      destroyMonth(month);
      return;
    }
    this.adopt(month, this.chunksValue.indexOf(chunk), at);
    this.pendingRespawn = true;
  }

  /**
   * Field of a month and, when a tint is chosen, the tint for the same
   * month. A missing or unreadable tint falls back to speed colors.
   */
  private async loadMonth(
    chunk: CatalogGeoVideoSource,
    at?: number,
    tintChunks = this.tintChunks,
  ): Promise<ProjversorMonth> {
    const tintChunk = pairChunk(chunk, tintChunks);
    const [field, tint] = await Promise.allSettled([
      this.loadField(chunk, at),
      tintChunk ? this.loadField(tintChunk, at) : null,
    ]);
    if (field.status === "rejected") {
      if (tint.status === "fulfilled") {
        tint.value?.destroy();
      }
      throw field.reason;
    }
    if (tint.status === "rejected") {
      console.error(tint.reason);
    }
    return {
      field: field.value,
      tint: tint.status === "fulfilled" ? tint.value : null,
    };
  }

  /** Manifest and first decoded frame (at `at`, else the start) of a month. */
  private async loadField(
    chunk: CatalogGeoVideoSource,
    at?: number,
  ): Promise<GeoVideoField> {
    const manifest = await loadGeoVideoManifest(chunk.manifestUrl);
    const field = new GeoVideoField(this.gl, manifest);
    try {
      await field.prime(at ?? field.times[0]);
    } catch (error) {
      field.destroy();
      throw error;
    }
    return field;
  }

  private adopt(month: ProjversorMonth, chunkIndex: number, at?: number): void {
    this.field?.destroy();
    this.tint?.destroy();
    const { field } = month;
    this.field = field;
    this.tint = month.tint;
    this.chunkIndexValue = chunkIndex;
    const { times } = field;
    this.ms = Math.min(
      Math.max(at ?? times[0], times[0]),
      times[times.length - 1],
    );
    // Also on automatic month changes: a month may gain or lose its tint.
    this.emit("month", month);
    this.setStatus("");
  }

  /**
   * Decode the next month in the background so playback runs through the
   * whole archive like a film, wrapping to the first month after the last.
   */
  private prefetchNext(): void {
    if (this.upcoming || this.chunksValue.length < 2) {
      return;
    }
    const id = this.loadId;
    const index = (this.chunkIndexValue + 1) % this.chunksValue.length;
    const upcoming: Upcoming = { index, month: null };
    this.upcoming = upcoming;
    this.loadMonth(this.chunksValue[index])
      .then((month) => {
        if (this.upcoming === upcoming && id === this.loadId) {
          upcoming.month = month;
        } else {
          destroyMonth(month);
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        if (this.upcoming === upcoming) {
          // Skip the unreadable month on the next attempt.
          this.chunkIndexValue = index;
          this.upcoming = null;
        }
      });
  }

  private dropUpcoming(): void {
    if (this.upcoming?.month) {
      destroyMonth(this.upcoming.month);
    }
    this.upcoming = null;
  }

  // ---- styling and playback ----------------------------------------------

  /**
   * Style the shown layer: engine defaults, then catalog, then layer, then
   * the view's override, which `viewStyle` replaces. The grade is the
   * style's: a picked grade lives in the override.
   */
  private restyle(viewStyle?: LayerStyleInput): void {
    if (viewStyle !== undefined) {
      this.viewStyle = viewStyle;
    }
    const layer = this.layerValue;
    const entry = requireCatalogEntry(layer.entryId);
    const style = resolveEntryStyle(entry, layer.style, this.viewStyle);
    this.particleSettings = style.particles;
    this.rasterOpacity = style.raster.opacity;
    this.rasterVibrance = style.raster.vibrance;
    this.trailFade.setBase(fadeToOpacity(style.particles.fade));
    // Paused particles redraw their trails with the new style.
    this.settle = this.settleFrames();
    this.gradeValue = gradeToColorGrade(style.particles.grade);
  }

  /** The view style's palette when the layer offers it, else its own. */
  private stylePalette(layer: ProjversorLayer): string {
    const id = this.viewStyle.palette;
    return id !== undefined && layerPalettes(layer).some((p) => p.id === id)
      ? id
      : layer.style.palette;
  }

  /** Set the view style's palette, shown when the layer offers it. */
  setPalette(id: string): void {
    this.restyle(mergeStyles(this.viewStyle, { palette: id }));
    this.applyPalette(this.stylePalette(this.layerValue));
  }

  /** Set the view style's particle grade. */
  setGrade(grade: ColorGrade): void {
    this.restyle(
      mergeStyles(this.viewStyle, {
        particles: { grade: colorGradeToGrade(grade) },
      }),
    );
  }

  /** Recolor the particles or the raster. */
  private applyPalette(id: string): void {
    if (this.ramp) {
      this.gl.deleteTexture(this.ramp);
    }
    this.paletteId = id;
    this.ramp = createColorRampTexture(this.gl, id);
    this.settle = this.settleFrames();
    this.emit("palette", id);
  }

  /** Set a kind's speed when it is one of that kind's {@link SPEEDS}. */
  private setKindSpeed(kind: ProjversorLayer["kind"], speed?: number): void {
    if (speed !== undefined && SPEEDS[kind].includes(speed)) {
      this.speeds[kind] = speed;
    }
  }

  /** Playback speed multiplier of the open layer's kind. */
  setSpeed(speed: number): void {
    this.speeds[this.layerValue.kind] = speed;
  }

  setPlaying(playing: boolean): void {
    if (this.playingValue !== playing) {
      this.playingValue = playing;
      this.emit("playing", playing);
    }
  }

  /** Hold playback, e.g. while a timeline thumb is held. */
  setHeld(held: boolean): void {
    this.held = held;
  }

  private setStatus(text: string): void {
    this.emit("status", text);
  }

  // ---- view --------------------------------------------------------------

  /**
   * Morph to a preset (with its own rotation and zoom unless given), or
   * ease rotation and zoom alone.
   */
  goTo(target: ProjversorViewTarget): void {
    const preset = findPreset(target.preset);
    if (target.inset) {
      this.setInset(
        target.inset,
        target.durationMs ?? (preset ? TRANSITION_MS : VIEW_MS),
      );
    }
    if (preset) {
      this.morph(
        preset,
        target.rotate ?? preset.rotate,
        target.zoom ?? preset.zoom,
        target.durationMs ?? TRANSITION_MS,
      );
      return;
    }
    const { rotate, zoom } = this.target();
    this.easeTo(
      target.rotate ?? rotate,
      clampZoom(target.zoom ?? zoom),
      target.durationMs,
    );
  }

  /** Show a preset, rotation and zoom at once. */
  jumpTo(target: ProjversorViewTarget): void {
    const preset = findPreset(target.preset) ?? this.presetValue;
    const def = PROJECTIONS[preset.projection];
    if (target.inset) {
      this.setInset(target.inset, 0);
    }
    const { width, height } = viewArea(this.view);
    const k = fitScale(def, width, height);
    this.transition = null;
    this.view.blend = { a: def, b: def, ka: k, kb: k, t: 0 };
    this.view.rotate = this.lockNorth(
      target.rotate ?? (target.preset ? preset.rotate : [...this.view.rotate]),
    );
    this.view.zoom = clampZoom(
      target.zoom ?? (target.preset ? preset.zoom : this.view.zoom),
    );
    this.setPreset(preset);
  }

  private morph(
    preset: Preset,
    rotate: Rotate,
    zoom: number,
    duration: number,
  ): void {
    const { blend } = this.view;
    const from = blend.t < 0.5 ? blend.a : blend.b;
    const to = PROJECTIONS[preset.projection];
    const { width, height } = viewArea(this.view);
    this.view.blend = {
      a: from,
      b: to,
      ka: fitScale(from, width, height),
      kb: fitScale(to, width, height),
      t: 0,
    };
    this.transition = {
      start: performance.now(),
      duration,
      rotate: interpolateRotation(this.view.rotate, rotate),
      zoom: [this.view.zoom, clampZoom(zoom)],
    };
    this.setPreset(preset);
  }

  private setPreset(preset: Preset): void {
    this.presetValue = preset;
    this.emit("preset", preset);
  }

  /**
   * Ease rotation and zoom from the current view; repeated calls chain from
   * the previous target. Waits out a projection morph.
   */
  easeTo(rotate: Rotate, zoom: number, duration = VIEW_MS): void {
    const { blend } = this.view;
    if (this.transition && blend.a !== blend.b) {
      return;
    }
    const from = this.view.rotate;
    this.transition = {
      start: performance.now(),
      duration,
      rotate: (t) => [
        from[0] + (rotate[0] - from[0]) * t,
        from[1] + (rotate[1] - from[1]) * t,
        from[2] + (rotate[2] - from[2]) * t,
      ],
      zoom: [this.view.zoom, zoom],
    };
  }

  zoomBy(factor: number): void {
    const { rotate, zoom } = this.target();
    this.easeTo(rotate, clampZoom(zoom * factor));
  }

  /** Spin the globe around its axis; positive moves the map content right. */
  rotateBy(deg: number): void {
    const { rotate, zoom } = this.target();
    this.easeTo([rotate[0] + deg, rotate[1], rotate[2]], zoom);
  }

  /** Rotate the map around the view center; frees the bearing. */
  setBearing(deg: number): void {
    if (this.transition) {
      return;
    }
    this.northLocked = false;
    this.view.rotate = withBearing(this.view.rotate, deg);
  }

  /** Free the bearing, or ease back to north up and lock it. */
  toggleNorth(): void {
    if (this.north) {
      this.northLocked = false;
      return;
    }
    this.northLocked = true;
    // A projection morph already ends north up.
    const { rotate, zoom } = this.target();
    this.easeTo([rotate[0], rotate[1], 0], zoom);
  }

  /** Where the running view easing ends, else the current view. */
  target(): { rotate: Rotate; zoom: number } {
    const transition = this.transition;
    return transition
      ? { rotate: transition.rotate(1), zoom: transition.zoom[1] }
      : { rotate: this.view.rotate, zoom: this.view.zoom };
  }

  /** Lock north up for a near-zero bearing, and snap it to zero. */
  private lockNorth(rotate: Rotate): Rotate {
    this.northLocked = Math.abs(rotationBearing(rotate)) < NORTH_EPSILON;
    return this.north ? withBearing(rotate, 0) : [...rotate];
  }

  /**
   * Ease the free zone to `inset` (at once for a zero duration); the sphere
   * slides and refits with it.
   */
  setInset(inset: Inset, durationMs = VIEW_MS): void {
    const from = this.view.inset ?? NO_INSET;
    if (durationMs <= 0) {
      this.insetTransition = null;
      this.view.inset = { ...inset };
      this.refit();
      return;
    }
    this.insetTransition = {
      start: performance.now(),
      duration: durationMs,
      from: { ...from },
      to: { ...inset },
    };
  }

  /** Free zone, css px. */
  get inset(): Inset {
    return this.insetTransition?.to ?? this.view.inset ?? NO_INSET;
  }

  /**
   * Screen direction of north at the center of the free zone, degrees
   * clockwise from up; null near a pole, where it has none.
   */
  northAngle(): number | null {
    const frame = viewFrame(this.view);
    const projection = this.overlay.setView(frame);
    const { cx, cy } = viewArea(frame);
    return screenNorth(projection as ScreenProjection, [cx, cy]);
  }

  /**
   * Outline of the projected sphere, css px: the globe limb, or the edge of
   * a world map. The largest ring when the projection splits it.
   */
  outline(): [number, number][] {
    const projection = this.overlay.setView(viewFrame(this.view));
    const rings: [number, number][][] = [];
    let ring: [number, number][] = [];
    geoPath(projection, {
      moveTo: (x: number, y: number) => {
        ring = [[x, y]];
        rings.push(ring);
      },
      lineTo: (x: number, y: number) => ring.push([x, y]),
      closePath: () => undefined,
      arc: () => undefined,
    } as unknown as CanvasRenderingContext2D)({ type: "Sphere" });
    return rings.reduce<[number, number][]>(
      (best, r) => (r.length > best.length ? r : best),
      [],
    );
  }

  /** Fit scales of both blended projections to the free zone. */
  private refit(): void {
    const { blend } = this.view;
    const { width, height } = viewArea(this.view);
    blend.ka = fitScale(blend.a, width, height);
    blend.kb = fitScale(blend.b, width, height);
    this.overlayKey = "";
  }

  private animateInset(now: number): void {
    const step = this.insetTransition;
    if (!step) {
      return;
    }
    const raw = Math.min(1, (now - step.start) / step.duration);
    this.view.inset = lerpInset(step.from, step.to, easeCubicInOut(raw));
    this.refit();
    if (raw >= 1) {
      this.insetTransition = null;
    }
  }

  private animate(now: number): void {
    this.animateInset(now);
    const transition = this.transition;
    if (!transition) {
      return;
    }
    const raw = Math.min(1, (now - transition.start) / transition.duration);
    const e = easeCubicInOut(raw);
    this.view.blend.t = e;
    this.view.rotate = transition.rotate(e);
    this.view.zoom =
      transition.zoom[0] + (transition.zoom[1] - transition.zoom[0]) * e;
    if (raw >= 1) {
      const { b, kb } = this.view.blend;
      this.view.blend = { a: b, b, ka: kb, kb, t: 0 };
      this.transition = null;
    }
  }

  private resize(): void {
    const { stage, back, gl, front } = this.canvases;
    const { clientWidth: width, clientHeight: height } = stage;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [back, gl, front]) {
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
    }
    this.view.width = width;
    this.view.height = height;
    this.refit();
    this.particles.resize(gl.width, gl.height);
  }

  // ---- interaction -------------------------------------------------------

  /**
   * Versor drag, pinch and wheel zoom on the front canvas; the stage gets
   * the `dragging` class during a drag. Returns the detach function.
   */
  attachInteraction(): () => void {
    const { stage, front } = this.canvases;
    const controller = new AbortController();
    const { signal } = controller;
    // Active pointers in client px; two of them pinch-zoom.
    const pointers = new Map<number, [number, number]>();
    let pinch: { spread: number; zoom: number } | null = null;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    front.addEventListener(
      "pointerdown",
      (event) => {
        if (this.transition) {
          return;
        }
        front.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, [event.clientX, event.clientY]);
        if (pointers.size > 1) {
          this.drag = null;
          pinch = { spread: Math.max(1, spread()), zoom: this.view.zoom };
          return;
        }
        const at = this.invert(event, this.view.rotate);
        if (!at) {
          return;
        }
        stage.classList.add("dragging");
        this.drag = {
          v0: cartesian(...at),
          q0: versor(this.view.rotate),
          r0: [...this.view.rotate],
        };
      },
      { signal },
    );
    front.addEventListener(
      "pointermove",
      (event) => {
        if (pointers.has(event.pointerId)) {
          pointers.set(event.pointerId, [event.clientX, event.clientY]);
        }
        if (pinch) {
          if (pointers.size > 1) {
            this.view.zoom = clampZoom((pinch.zoom * spread()) / pinch.spread);
          }
          return;
        }
        const drag = this.drag;
        if (!drag) {
          return;
        }
        const at = this.invert(event, drag.r0);
        if (!at) {
          return;
        }
        const q1 = versorMultiply(
          drag.q0,
          versorDelta(drag.v0, cartesian(...at)),
        );
        const rotate = versorRotation(q1);
        this.view.rotate = this.north ? withBearing(rotate, 0) : rotate;
      },
      { signal },
    );
    const end = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) {
        pinch = null;
      }
      this.drag = null;
      stage.classList.remove("dragging");
    };
    front.addEventListener("pointerup", end, { signal });
    front.addEventListener("pointercancel", end, { signal });
    front.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (this.transition) {
          return;
        }
        const zoom = this.view.zoom * Math.exp(-event.deltaY * 0.0015);
        this.view.zoom = clampZoom(zoom);
      },
      { passive: false, signal },
    );
    return () => {
      controller.abort();
      this.drag = null;
      stage.classList.remove("dragging");
    };
  }

  private invert(event: PointerEvent, rotate: Rotate): [number, number] | null {
    const projection = this.overlay.setView(
      viewFrame({ ...this.view, rotate }),
    );
    const at = projection.invert?.([event.offsetX, event.offsetY]);
    return at && Number.isFinite(at[0]) && Number.isFinite(at[1])
      ? [at[0], at[1]]
      : null;
  }

  // ---- frame -------------------------------------------------------------

  /** Playing and not held. */
  private get advancing(): boolean {
    return this.playingValue && !this.held;
  }

  private tick(now: number): void {
    if (this.destroyed) {
      return;
    }
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.animate(now);
    this.advanceTime(dt);
    const frame = viewFrame(this.view);
    this.drawOverlay(frame, now);
    this.drawField(frame, now);
    this.emit("frame", undefined);
    this.frameId = requestAnimationFrame((t) => this.tick(t));
  }

  /** Trail length in frames, capped: how long a paused view keeps animating. */
  private settleFrames(): number {
    return Math.min(
      SETTLE_FRAMES_MAX,
      Math.round(fadeToFrames(this.particleSettings.fade)),
    );
  }

  /** Clear the GL canvas, then draw the open field as particles or a raster. */
  private drawField(frame: ViewFrame, now: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const field = this.field;
    if (!field || !this.ramp) {
      return;
    }
    if (field.vector) {
      this.drawParticles(frame, field, this.ramp, now);
    } else {
      this.raster.draw(frame, field, this.ms, {
        ramp: this.ramp,
        domain: field.domain,
        opacity: this.rasterOpacity,
        vibrance: this.rasterVibrance,
      });
    }
  }

  /**
   * zartigl's particle pipeline: advect, fade the trails, draw the new
   * segments, composite. While paused, particles only animate for a while
   * after a change, to rebuild trails, then the image holds.
   */
  private drawParticles(
    frame: ViewFrame,
    field: GeoVideoField,
    ramp: WebGLTexture,
    now: number,
  ): void {
    const gl = this.gl;
    const moving = now - this.lastMove < MOVE_SETTLE_MS;
    if (moving) {
      this.settle = this.settleFrames();
    }
    this.trailFade.setMoving(moving, now);
    this.redistribute(frame);
    if (this.pendingRespawn) {
      // step() binds the field, which requests the frames at the playhead.
      this.pendingRespawn = false;
      this.particles.clear();
      this.particles.respawn();
      this.settle = this.settleFrames();
    }
    const style: ParticleStyle = {
      ramp,
      maxSpeed: field.maxSpeed,
      // Playback speed drives the particles as well as the video.
      speed: this.particleSettings.speed * particleSpeedFactor(this.speed),
      count: particleCount(
        this.particleSettings,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
      ),
      drop: Math.min(DROP_RATE + this.redistribution, REDISTRIB_MAX_DROP),
      dropBump: DROP_RATE_BUMP,
      tint: this.tint,
    };
    const animate = this.advancing || this.settle > 0;
    if (animate && this.particles.step(frame, field, this.ms, style)) {
      const fade = this.trailFade.value(now);
      this.particles.trace(frame, field, this.ms, style, fade);
      // Paused: count down only once the playhead frames are decoded, so a
      // scrub to uncached frames still rebuilds trails on the right field.
      const ready = field.ready(this.ms) && (this.tint?.ready(this.ms) ?? true);
      if (!this.advancing && ready) {
        this.settle--;
      }
    }
    this.particles.present(this.gradeValue);
  }

  /** zartigl's drop-rate boost, from the per-frame zoom and center change. */
  private redistribute(frame: ViewFrame): void {
    const center: Rotate = [frame.rotInv[0], frame.rotInv[1], frame.rotInv[2]];
    if (this.lastScale > 0) {
      const [x, y, z] = this.lastCenter;
      const dot = x * center[0] + y * center[1] + z * center[2];
      const delta = Math.min(
        1,
        Math.abs(Math.log(frame.pxPerRadian / this.lastScale)) +
          Math.acos(Math.min(1, Math.max(-1, dot))) / visibleCap(frame),
      );
      this.redistribution = Math.max(
        this.redistribution * REDISTRIB_DECAY,
        delta,
      );
    }
    this.lastScale = frame.pxPerRadian;
    this.lastCenter = center;
  }

  /** Coastlines and graticule: coarse while the view moves, then detailed. */
  private drawOverlay(frame: ViewFrame, now: number): void {
    const key = JSON.stringify([
      frame.rotate,
      frame.zoom,
      frame.blend.t,
      frame.blend.a.id,
      frame.blend.b.id,
      frame.width,
      frame.height,
      frame.inset,
    ]);
    if (key !== this.overlayKey) {
      this.overlayKey = key;
      this.lastMove = now;
      this.detailed = false;
      this.overlay.draw(frame, this.dpr, false);
    } else if (!this.detailed && now - this.lastMove > 180) {
      this.detailed = true;
      this.overlay.draw(frame, this.dpr, true);
    }
  }

  private advanceTime(dt: number): void {
    const times = this.field?.times;
    if (!times || times.length < 2 || !this.advancing) {
      return;
    }
    const first = times[0];
    const lastTime = times[times.length - 1];
    const stepMs = (lastTime - first) / (times.length - 1);
    this.ms += dt * STEPS_PER_SECOND * this.speed * stepMs;
    if ((this.ms - first) / (lastTime - first) > PREFETCH_AT) {
      this.prefetchNext();
    }
    if (this.ms > lastTime) {
      const upcoming = this.upcoming;
      if (this.chunksValue.length < 2) {
        this.ms = first;
      } else if (upcoming?.month) {
        this.upcoming = null;
        this.adopt(upcoming.month, upcoming.index);
        this.advanceTime(0);
      } else {
        this.ms = lastTime;
        this.setStatus("Buffering…");
      }
    }
  }

  /** Stop the frame loop and free GL resources and listeners. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    ++this.loadId;
    cancelAnimationFrame(this.frameId);
    this.resizer.disconnect();
    this.dropUpcoming();
    this.field?.destroy();
    this.tint?.destroy();
    this.field = null;
    this.tint = null;
    if (this.ramp) {
      this.gl.deleteTexture(this.ramp);
      this.ramp = null;
    }
    this.particles.destroy();
    this.raster.destroy();
    this.listeners.clear();
  }
}
