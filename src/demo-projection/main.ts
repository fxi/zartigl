import { easeCubicInOut } from "d3";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land110 from "world-atlas/land-110m.json";
import land50 from "world-atlas/land-50m.json";
import {
  requireCatalogEntry,
  sourceCoversTime,
  type CatalogGeoVideoSource,
} from "../catalog";
import {
  TrailFade,
  createColorRampTexture,
  fadeToFrames,
  fadeToOpacity,
  loadGeoVideoManifest,
  pairChunk,
} from "../engine";
import { rotationBearing, withBearing } from "./bearing";
import { Compass } from "./Compass";
import { GeoVideoField } from "./GeoVideoField";
import {
  DEMO_LAYERS,
  TINT_LAYERS,
  findLayer,
  layerPalettes,
  loadChunks,
  loadTintChunks,
  type DemoLayer,
} from "./layers";
import { Overlay } from "./Overlay";
import {
  PROJECTIONS,
  cartesian,
  fitScale,
  type ProjectionId,
} from "./projections";
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
  dayTicks,
  formatUnit,
  linearTicks,
  legendTicks,
  particleCount,
  particleSettings,
  particleSpeedFactor,
  rampGradient,
  rampPosition,
  type ParticleSettings,
} from "./scales";
import { decodeShare, encodeShare, type ShareState } from "./share";
import { regionView, viewFrame, type View, type ViewFrame } from "./view";

/** Field time steps played per second at 1×. */
const STEPS_PER_SECOND = 0.4;
const SPEEDS = [0.5, 1, 2, 5];
const TRANSITION_MS = 2200;
/** Easing of compass, zoom and rotate buttons. */
const VIEW_MS = 450;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
/** Zoom button factor and rotate button step (degrees of longitude). */
const ZOOM_STEP = 1.5;
const ROTATE_STEP = 15;
/** Shared bearings below this (degrees) open locked north up. */
const NORTH_EPSILON = 0.5;
/** Fraction of a month after which the next one is decoded. */
const PREFETCH_AT = 0.6;
/** How long the Share button confirms the copy. */
const COPIED_MS = 1500;
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

/** The fields of one month: the vector field and its optional tint. */
interface Month {
  field: GeoVideoField;
  tint: GeoVideoField | null;
}

function destroyMonth(month: Month): void {
  month.field.destroy();
  month.tint?.destroy();
}

interface Upcoming {
  index: number;
  month: Month | null;
}

interface Preset {
  id: string;
  label: string;
  projection: ProjectionId;
  rotate: [number, number, number];
  zoom: number;
}

const PRESETS: Preset[] = [
  {
    id: "south",
    label: "South Pole",
    projection: "azimuthalEquidistant",
    rotate: [0, 90, 0],
    zoom: 2.2,
  },
  {
    id: "north",
    label: "North Pole",
    projection: "azimuthalEqualArea",
    rotate: [0, -90, 0],
    zoom: 2.3,
  },
  {
    id: "globe",
    label: "Globe",
    projection: "orthographic",
    rotate: [-20, 25, 0],
    zoom: 1,
  },
  {
    id: "world",
    label: "Equal Earth",
    projection: "equalEarth",
    rotate: [-150, 0, 0],
    zoom: 1,
  },
  {
    id: "mollweide",
    label: "Mollweide",
    projection: "mollweide",
    rotate: [-20, 0, 0],
    zoom: 1,
  },
  {
    id: "plate",
    label: "Plate carrée",
    projection: "equirectangular",
    rotate: [0, 0, 0],
    zoom: 1,
  },
  {
    id: "lambert",
    label: "Equal-area",
    projection: "azimuthalEqualArea",
    rotate: [-160, 10, 0],
    zoom: 1.1,
  },
];

function refs(root: HTMLElement) {
  const get = <T extends Element>(name: string): T => {
    const el = root.querySelector<T>(`[data-ref="${name}"]`);
    if (!el) {
      throw new Error(`Missing element: ${name}`);
    }
    return el;
  };
  return {
    stage: get<HTMLElement>("stage"),
    back: get<HTMLCanvasElement>("back"),
    gl: get<HTMLCanvasElement>("gl"),
    front: get<HTMLCanvasElement>("front"),
    provider: get<HTMLElement>("provider"),
    projectionName: get<HTMLElement>("projectionName"),
    status: get<HTMLElement>("status"),
    date: get<HTMLElement>("date"),
    hour: get<HTMLElement>("hour"),
    time: get<HTMLInputElement>("time"),
    zoomIn: get<HTMLButtonElement>("zoomIn"),
    zoomOut: get<HTMLButtonElement>("zoomOut"),
    rotateLeft: get<HTMLButtonElement>("rotateLeft"),
    rotateRight: get<HTMLButtonElement>("rotateRight"),
    days: get<HTMLElement>("days"),
    compass: get<HTMLButtonElement>("compass"),
    needle: get<SVGElement>("needle"),
    play: get<HTMLButtonElement>("play"),
    month: get<HTMLSelectElement>("month"),
    speed: get<HTMLSelectElement>("speed"),
    palette: get<HTMLSelectElement>("palette"),
    unit: get<HTMLElement>("unit"),
    speedKey: get<HTMLElement>("speedKey"),
    speedMax: get<HTMLElement>("speedMax"),
    ramp: get<HTMLElement>("ramp"),
    ticks: get<HTMLElement>("ticks"),
    projection: get<HTMLSelectElement>("projection"),
    layer: get<HTMLSelectElement>("layer"),
    tintField: get<HTMLElement>("tintField"),
    tint: get<HTMLSelectElement>("tint"),
    share: get<HTMLButtonElement>("share"),
  };
}

const landFeature = (topology: unknown) => {
  const t = topology as Topology<{ land: GeometryCollection }>;
  return feature(t, t.objects.land);
};

class ProjectionDemo {
  private readonly ui: ReturnType<typeof refs>;
  private readonly gl: WebGL2RenderingContext;
  private readonly particles: SphereParticles;
  private readonly raster: SphereScalar;
  private readonly trailFade = new TrailFade(fadeToOpacity(0.7));
  /** Drop-rate boost after a view change, and the view it was measured on. */
  private redistribution = 0;
  private lastScale = 0;
  private lastCenter: [number, number, number] = [1, 0, 0];
  /** Frames left to animate while paused. */
  private settle = 0;
  private readonly overlay: Overlay;
  private readonly compass: Compass;
  /** Drags keep north up (gamma 0), as d3-geo-zoom's northUp. */
  private northLocked = true;
  /** Playback speed multiplier. */
  private speed = 1;
  /** Palette of the particles and legend. */
  private palette = "";
  private ramp: WebGLTexture | null = null;
  /** The open layer: particles for a vector one, a raster for a scalar one. */
  private layer: DemoLayer = DEMO_LAYERS[0];
  /** Catalog opacity of a scalar layer's raster. */
  private rasterOpacity = 1;
  private field: GeoVideoField | null = null;
  /** Scalar field coloring the particles, when a tint is chosen. */
  private tint: GeoVideoField | null = null;
  /** Scalar entry id of the chosen tint. */
  private tintId: string | null = null;
  /** Month chunks of the tint archive, paired by calendar period. */
  private tintChunks: CatalogGeoVideoSource[] = [];
  /** Month chunks of the open layer's archive. */
  private chunks: CatalogGeoVideoSource[] = [];
  private chunkIndex = 0;
  /** Particle settings of the open layer. */
  private particleSettings: ParticleSettings = particleSettings(
    undefined,
    undefined,
  );
  /** Next month, decoded ahead of the playhead. */
  private upcoming: Upcoming | null = null;
  /** Bumped on every layer or month switch; stale loads drop out. */
  private loadId = 0;
  private view: View;
  private dpr = 1;
  private ms = 0;
  private playing = true;
  /** Timeline thumb held: playback waits for its release. */
  private scrubbing = false;
  /** Particles must respawn in the view once the playhead frames are ready. */
  private pendingRespawn = false;
  /** View and playhead from the url hash, applied on load. */
  private readonly shared: Partial<ShareState>;
  private copiedTimer = 0;
  private overlayKey = "";
  private lastMove = 0;
  private detailed = false;
  private last = 0;
  private transition: {
    start: number;
    duration: number;
    rotate: (t: number) => [number, number, number];
    zoom: [number, number];
  } | null = null;
  private drag: {
    v0: [number, number, number];
    q0: ReturnType<typeof versor>;
    r0: [number, number, number];
  } | null = null;

  constructor(root: HTMLElement) {
    this.ui = refs(root);
    const gl = this.ui.gl.getContext("webgl2", {
      premultipliedAlpha: false,
      antialias: true,
      depth: true,
    });
    if (!gl) {
      throw new Error("WebGL2 is required");
    }
    this.gl = gl;
    this.particles = new SphereParticles(gl);
    this.raster = new SphereScalar(gl);
    this.overlay = new Overlay(this.ui.back, this.ui.front, {
      land: landFeature(land110),
      landDetail: landFeature(land50),
    });
    this.shared = decodeShare(location.hash);
    const preset =
      PRESETS.find((p) => p.id === this.shared.preset) ?? PRESETS[0];
    const def = PROJECTIONS[preset.projection];
    let rotate = this.shared.rotate ?? preset.rotate;
    this.northLocked = Math.abs(rotationBearing(rotate)) < NORTH_EPSILON;
    if (this.northLocked) {
      rotate = withBearing(rotate, 0);
    }
    this.compass = new Compass(this.ui.compass, this.ui.needle, {
      onBearing: (deg) => this.setBearing(deg),
      onToggle: () => this.toggleNorth(),
    });
    this.compass.locked = this.northLocked;
    if (SPEEDS.includes(this.shared.speed ?? Number.NaN)) {
      this.speed = this.shared.speed!;
    }
    this.view = {
      blend: { a: def, b: def, ka: 1, kb: 1, t: 0 },
      rotate,
      zoom: this.shared.zoom ?? preset.zoom,
      width: 1,
      height: 1,
    };
    this.buildPickers(preset.id);
    this.bindInteraction();
    this.setPlaying(this.shared.playing ?? true);
    new ResizeObserver(() => this.resize()).observe(this.ui.stage);
    this.resize();
    requestAnimationFrame((now) => this.tick(now));
  }

  load(): Promise<void> {
    const layer = findLayer(this.shared.layer) ?? DEMO_LAYERS[0];
    const palette = layerPalettes(layer).some(
      (p) => p.id === this.shared.palette,
    )
      ? this.shared.palette
      : undefined;
    // "" is a shared "no tint"; unknown ids fall back to the layer's own.
    const { tint } = this.shared;
    return this.openLayer(layer, {
      at: this.shared.time,
      palette,
      tint: tint === "" ? null : isTintEntry(tint) ? tint : undefined,
      // A shared view keeps its own framing.
      frame: this.shared.rotate === undefined && this.shared.zoom === undefined,
    });
  }

  /**
   * Switch layer, opening the month that holds `at`, else the displayed
   * month when the archive has it, else the latest. Palette and tint default
   * to the layer's own; `frame` centers the view on a regional layer.
   */
  private async openLayer(
    layer: DemoLayer,
    options: {
      at?: number;
      palette?: string;
      tint?: string | null;
      frame?: boolean;
    } = {},
  ): Promise<void> {
    const { at, palette = layer.palette, frame = true } = options;
    const tintId =
      layer.kind === "vector"
        ? options.tint === undefined
          ? (layer.tint ?? null)
          : options.tint
        : null;
    const id = ++this.loadId;
    this.dropUpcoming();
    const entry = requireCatalogEntry(layer.entryId);
    this.setStatus(`Loading ${layer.label}…`);
    // An unreadable tint index leaves no tint chunks, not a failed layer.
    const [chunks, tintChunks] = await Promise.all([
      loadChunks(layer.entryId),
      loadTintChunks(tintId),
    ]);
    if (id !== this.loadId) {
      return;
    }
    this.layer = layer;
    this.tintId = tintId;
    this.tintChunks = tintChunks;
    this.syncLayerPickers();
    const month = this.chunks[Number(this.ui.month.value)]?.temporal?.start;
    this.chunks = chunks;
    this.ui.month.replaceChildren(
      ...this.chunks.map(
        (chunk, i) => new Option(monthLabel(chunk), String(i)),
      ),
    );
    const holding =
      at === undefined
        ? -1
        : this.chunks.findIndex((c) => sourceCoversTime(c, { time: at }));
    const same = this.chunks.findIndex((c) => c.temporal?.start === month);
    const chunkIndex =
      holding >= 0 ? holding : same >= 0 ? same : this.chunks.length - 1;
    this.ui.month.value = String(chunkIndex);
    this.ui.provider.textContent = providerLabel(
      chunks[0]?.provenance?.provider,
    );
    this.overlay.fillLand = layer.fillLand;
    this.overlayKey = "";
    this.particleSettings = particleSettings(
      entry.defaults?.particles,
      layer.particles,
    );
    this.rasterOpacity = entry.defaults.raster?.opacity ?? 1;
    this.trailFade.setBase(fadeToOpacity(this.particleSettings.fade));
    this.setPalette(palette);
    await this.openChunk(this.chunks[chunkIndex], id, at);
    const region =
      frame && this.field && id === this.loadId
        ? regionView(this.field.bounds, this.view)
        : null;
    if (region) {
      this.animateView(region.rotate, clampZoom(region.zoom));
    }
  }

  /** Layer, tint and palette pickers for the open layer. */
  private syncLayerPickers(): void {
    const { layer, tint, tintField, palette } = this.ui;
    layer.value = this.layer.id;
    tintField.hidden = this.layer.kind !== "vector";
    tint.value = this.tintId ?? "";
    palette.replaceChildren(
      ...layerPalettes(this.layer).map((p) => new Option(p.label, p.id)),
    );
  }

  /** Open a month at `at`, or at its start. */
  private async openChunk(
    chunk: CatalogGeoVideoSource,
    id = ++this.loadId,
    at?: number,
  ): Promise<void> {
    this.dropUpcoming();
    this.setStatus("Decoding…");
    const month = await this.loadMonth(chunk, at);
    if (id !== this.loadId) {
      destroyMonth(month);
      return;
    }
    this.adopt(month, this.chunks.indexOf(chunk), at);
    this.pendingRespawn = true;
  }

  /**
   * Field of a month and, when a tint is chosen, the tint for the same
   * month. A missing or unreadable tint falls back to speed colors.
   */
  private async loadMonth(
    chunk: CatalogGeoVideoSource,
    at?: number,
  ): Promise<Month> {
    const tintChunk = pairChunk(chunk, this.tintChunks);
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

  private adopt(month: Month, chunkIndex: number, at?: number): void {
    this.field?.destroy();
    this.tint?.destroy();
    const { field } = month;
    this.field = field;
    this.tint = month.tint;
    this.chunkIndex = chunkIndex;
    this.ui.month.value = String(chunkIndex);
    const { times } = field;
    this.ms = Math.min(
      Math.max(at ?? times[0], times[0]),
      times[times.length - 1],
    );
    this.syncTimeline();
    this.buildDays(times);
    // Also on automatic month changes: a month may gain or lose its tint.
    this.buildLegend(month);
    this.setStatus("");
  }

  /**
   * Decode the next month in the background so playback runs through the
   * whole archive like a film, wrapping to the first month after the last.
   */
  private prefetchNext(): void {
    if (this.upcoming || this.chunks.length < 2) {
      return;
    }
    const id = this.loadId;
    const index = (this.chunkIndex + 1) % this.chunks.length;
    const upcoming: Upcoming = { index, month: null };
    this.upcoming = upcoming;
    this.loadMonth(this.chunks[index])
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
          this.chunkIndex = index;
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

  /** Recolor the particles and the legend. */
  private setPalette(id: string): void {
    if (this.ramp) {
      this.gl.deleteTexture(this.ramp);
    }
    this.palette = id;
    this.ui.palette.value = id;
    this.ramp = createColorRampTexture(this.gl, id);
    this.ui.ramp.style.background = rampGradient(id);
    this.settle = this.settleFrames();
  }

  private setStatus(text: string): void {
    if (this.ui.status.textContent !== text) {
      this.ui.status.textContent = text;
    }
  }

  // ---- projection & view -------------------------------------------------

  private buildPickers(activePreset: string): void {
    const { projection, layer, tint, month, speed, palette } = this.ui;
    projection.replaceChildren(
      ...PRESETS.map((preset) => new Option(preset.label, preset.id)),
    );
    projection.value = activePreset;
    this.ui.projectionName.textContent = projection.selectedOptions[0].text;
    projection.addEventListener("change", () => {
      const preset = PRESETS.find((p) => p.id === projection.value);
      if (preset) {
        this.ui.projectionName.textContent = preset.label;
        this.transitionTo(preset);
      }
    });
    layer.replaceChildren(
      optionGroup("Flows", DEMO_LAYERS, "vector"),
      optionGroup("Fields", DEMO_LAYERS, "scalar"),
    );
    layer.addEventListener("change", () => {
      const next = findLayer(layer.value);
      if (next) {
        this.openLayer(next).catch((error: unknown) => this.fail(error));
      }
    });
    tint.replaceChildren(
      new Option("Speed", ""),
      ...TINT_LAYERS.map((l) => new Option(l.label, l.entryId)),
    );
    tint.addEventListener("change", () => {
      this.openLayer(this.layer, {
        at: this.ms,
        palette: this.palette,
        tint: tint.value || null,
        frame: false,
      }).catch((error: unknown) => this.fail(error));
    });
    month.addEventListener("change", () => {
      const chunk = this.chunks[Number(month.value)];
      if (chunk) {
        this.openChunk(chunk).catch((error: unknown) => this.fail(error));
      }
    });
    speed.replaceChildren(...SPEEDS.map((s) => new Option(`${s}×`, String(s))));
    speed.value = String(this.speed);
    speed.addEventListener("change", () => {
      this.speed = Number(speed.value);
    });
    palette.addEventListener("change", () => this.setPalette(palette.value));
  }

  private fail(error: unknown): void {
    console.error(error);
    this.setStatus(String(error));
  }

  private transitionTo(preset: Preset): void {
    const { blend } = this.view;
    const from = blend.t < 0.5 ? blend.a : blend.b;
    const to = PROJECTIONS[preset.projection];
    const { width, height } = this.view;
    this.view.blend = {
      a: from,
      b: to,
      ka: fitScale(from, width, height),
      kb: fitScale(to, width, height),
      t: 0,
    };
    this.transition = {
      start: performance.now(),
      duration: TRANSITION_MS,
      rotate: interpolateRotation(this.view.rotate, preset.rotate),
      zoom: [this.view.zoom, preset.zoom],
    };
  }

  private animate(now: number): void {
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

  /** Rotate the map around the view center; frees the bearing. */
  private setBearing(deg: number): void {
    if (this.transition) {
      return;
    }
    this.setNorthLocked(false);
    this.view.rotate = withBearing(this.view.rotate, deg);
  }

  /** Free the bearing, or ease back to north up and lock it. */
  private toggleNorth(): void {
    if (this.northLocked) {
      this.setNorthLocked(false);
      return;
    }
    this.setNorthLocked(true);
    // A projection morph already ends north up.
    const [lambda, phi] = this.target().rotate;
    this.animateView([lambda, phi, 0], this.target().zoom);
  }

  private zoomBy(factor: number): void {
    const { rotate, zoom } = this.target();
    this.animateView(rotate, clampZoom(zoom * factor));
  }

  /** Spin the globe around its axis; positive moves the map content right. */
  private rotateBy(deg: number): void {
    const { rotate, zoom } = this.target();
    this.animateView([rotate[0] + deg, rotate[1], rotate[2]], zoom);
  }

  /** Where the running view easing ends, else the current view. */
  private target(): { rotate: [number, number, number]; zoom: number } {
    const transition = this.transition;
    return transition
      ? { rotate: transition.rotate(1), zoom: transition.zoom[1] }
      : { rotate: this.view.rotate, zoom: this.view.zoom };
  }

  /**
   * Ease rotation and zoom from the current view; repeated presses chain
   * from the previous target. Waits out a projection morph.
   */
  private animateView(rotate: [number, number, number], zoom: number): void {
    const { blend } = this.view;
    if (this.transition && blend.a !== blend.b) {
      return;
    }
    const from = this.view.rotate;
    this.transition = {
      start: performance.now(),
      duration: VIEW_MS,
      rotate: (t) => [
        from[0] + (rotate[0] - from[0]) * t,
        from[1] + (rotate[1] - from[1]) * t,
        from[2] + (rotate[2] - from[2]) * t,
      ],
      zoom: [this.view.zoom, zoom],
    };
  }

  private setNorthLocked(locked: boolean): void {
    this.northLocked = locked;
    this.compass.locked = locked;
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.ui.stage;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [this.ui.back, this.ui.gl, this.ui.front]) {
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
    }
    const { blend } = this.view;
    this.view.width = width;
    this.view.height = height;
    blend.ka = fitScale(blend.a, width, height);
    blend.kb = fitScale(blend.b, width, height);
    this.overlayKey = "";
    this.particles.resize(this.ui.gl.width, this.ui.gl.height);
  }

  // ---- interaction -------------------------------------------------------

  private bindInteraction(): void {
    const stage = this.ui.front;
    // Active pointers in client px; two of them pinch-zoom.
    const pointers = new Map<number, [number, number]>();
    let pinch: { spread: number; zoom: number } | null = null;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    stage.addEventListener("pointerdown", (event) => {
      if (this.transition) {
        return;
      }
      stage.setPointerCapture(event.pointerId);
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
      this.ui.stage.classList.add("dragging");
      this.drag = {
        v0: cartesian(...at),
        q0: versor(this.view.rotate),
        r0: [...this.view.rotate],
      };
    });
    stage.addEventListener("pointermove", (event) => {
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
      this.view.rotate = this.northLocked ? withBearing(rotate, 0) : rotate;
    });
    const end = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) {
        pinch = null;
      }
      this.drag = null;
      this.ui.stage.classList.remove("dragging");
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (this.transition) {
          return;
        }
        const zoom = this.view.zoom * Math.exp(-event.deltaY * 0.0015);
        this.view.zoom = clampZoom(zoom);
      },
      { passive: false },
    );

    this.ui.play.addEventListener("click", () =>
      this.setPlaying(!this.playing),
    );
    this.ui.share.addEventListener("click", () => this.share());
    this.ui.zoomIn.addEventListener("click", () => this.zoomBy(ZOOM_STEP));
    this.ui.zoomOut.addEventListener("click", () => this.zoomBy(1 / ZOOM_STEP));
    this.ui.rotateLeft.addEventListener("click", () =>
      this.rotateBy(-ROTATE_STEP),
    );
    this.ui.rotateRight.addEventListener("click", () =>
      this.rotateBy(ROTATE_STEP),
    );

    // The thumb drives the playhead like a jog wheel: playback holds while
    // it is held (pointer or key) and resumes on release.
    const time = this.ui.time;
    const hold = () => {
      this.scrubbing = true;
    };
    const release = () => {
      this.scrubbing = false;
    };
    time.addEventListener("pointerdown", (event) => {
      time.setPointerCapture(event.pointerId);
      hold();
    });
    time.addEventListener("keydown", hold);
    for (const type of ["pointerup", "pointercancel", "keyup", "blur"]) {
      time.addEventListener(type, release);
    }
    time.addEventListener("input", () => {
      const field = this.field;
      if (!field || field.times.length < 2) {
        return;
      }
      const { times } = field;
      this.ms =
        times[0] + Number(time.value) * (times[times.length - 1] - times[0]);
      field.focus(this.ms);
      this.tint?.focus(this.ms);
      time.style.setProperty("--p", time.value);
      this.settle = this.settleFrames();
    });
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && event.target === document.body) {
        event.preventDefault();
        this.setPlaying(!this.playing);
      }
    });
  }

  private invert(
    event: PointerEvent,
    rotate: [number, number, number],
  ): [number, number] | null {
    const projection = this.overlay.setView(
      viewFrame({ ...this.view, rotate }),
    );
    const at = projection.invert?.([event.offsetX, event.offsetY]);
    return at && Number.isFinite(at[0]) && Number.isFinite(at[1])
      ? [at[0], at[1]]
      : null;
  }

  /** Playing and not held by the timeline thumb. */
  private get advancing(): boolean {
    return this.playing && !this.scrubbing;
  }

  /** Copy a link to the displayed view. */
  private share(): void {
    const url = new URL(location.href);
    url.hash = encodeShare({
      layer: this.layer.id,
      time: this.ms,
      preset: this.ui.projection.value,
      rotate: this.view.rotate,
      zoom: this.view.zoom,
      playing: this.playing,
      speed: this.speed,
      palette: this.palette,
      tint: this.tintId ?? "",
    });
    // navigator.clipboard is missing outside secure contexts.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(url.href))
      .then(
        () => {
          const button = this.ui.share;
          button.classList.add("copied");
          button.setAttribute("aria-label", "Link copied");
          clearTimeout(this.copiedTimer);
          this.copiedTimer = window.setTimeout(() => {
            button.classList.remove("copied");
            button.setAttribute("aria-label", "Share");
          }, COPIED_MS);
        },
        () => this.setStatus(url.href),
      );
  }

  private setPlaying(playing: boolean): void {
    this.playing = playing;
    this.ui.play.classList.toggle("playing", playing);
    this.ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  // ---- frame -------------------------------------------------------------

  private tick(now: number): void {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.animate(now);
    this.advanceTime(dt);
    this.compass.bearing = rotationBearing(this.view.rotate);

    const frame = viewFrame(this.view);
    this.drawOverlay(frame, now);
    this.drawField(frame, now);
    requestAnimationFrame((t) => this.tick(t));
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
    this.particles.present();
  }

  /** zartigl's drop-rate boost, from the per-frame zoom and center change. */
  private redistribute(frame: ViewFrame): void {
    const center: [number, number, number] = [
      frame.rotInv[0],
      frame.rotInv[1],
      frame.rotInv[2],
    ];
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
    if (!times || times.length < 2) {
      return;
    }
    const first = times[0];
    const lastTime = times[times.length - 1];
    if (this.advancing) {
      const stepMs = (lastTime - first) / (times.length - 1);
      this.ms += dt * STEPS_PER_SECOND * this.speed * stepMs;
      if ((this.ms - first) / (lastTime - first) > PREFETCH_AT) {
        this.prefetchNext();
      }
      if (this.ms > lastTime) {
        const upcoming = this.upcoming;
        if (this.chunks.length < 2) {
          this.ms = first;
        } else if (upcoming?.month) {
          this.upcoming = null;
          this.adopt(upcoming.month, upcoming.index);
          return this.advanceTime(0);
        } else {
          this.ms = lastTime;
          this.setStatus("Buffering…");
        }
      }
      this.syncTimeline();
    }
    const date = new Date(this.ms);
    const day = date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    this.ui.date.textContent = `${day} ${date.getUTCFullYear()}`.toUpperCase();
    this.ui.hour.textContent = `${String(date.getUTCHours()).padStart(2, "0")}:00 UTC`;
  }

  /** Move the timeline thumb to the playhead. */
  private syncTimeline(): void {
    const times = this.field?.times;
    if (!times || times.length < 2) {
      return;
    }
    const first = times[0];
    const span = times[times.length - 1] - first;
    this.setTimeline((this.ms - first) / span);
  }

  /** Thumb position and the played part of the track, 0–1. */
  private setTimeline(value: number): void {
    this.ui.time.value = String(value);
    this.ui.time.style.setProperty("--p", String(value));
  }

  /**
   * Ramp ticks and unit: a scalar raster or the tint over its domain
   * (linear), the tint with a speed brightness key, else the speed
   * (square-root ramp).
   */
  private buildLegend({ field, tint }: Month): void {
    const speedUnit = formatUnit(field.manifest.style.unit);
    const tick = (value: number, position: number) => {
      const li = document.createElement("li");
      li.textContent = String(value);
      li.style.bottom = `${position * 100}%`;
      return li;
    };
    this.ui.speedKey.hidden = !tint;
    // The raster of a scalar layer, else the tint, colors over its domain.
    const scalar = field.vector ? tint : field;
    if (scalar) {
      const [min, max] = scalar.domain;
      this.ui.unit.textContent = formatUnit(scalar.manifest.style.unit);
      this.ui.ticks.replaceChildren(
        ...linearTicks(min, max).map((t) => tick(t.value, t.position)),
      );
      this.ui.speedMax.textContent = `${field.maxSpeed} ${speedUnit}`;
      return;
    }
    this.ui.unit.textContent = speedUnit;
    this.ui.ticks.replaceChildren(
      ...legendTicks(field.maxSpeed).map((value) =>
        tick(value, rampPosition(value, field.maxSpeed)),
      ),
    );
  }

  private buildDays(times: number[]): void {
    const ticks =
      times.length > 1 ? dayTicks(times[0], times[times.length - 1]) : [];
    this.ui.days.replaceChildren(
      ...ticks.map(({ label, position, major }) => {
        const li = document.createElement("li");
        if (major) {
          li.textContent = label;
        } else {
          li.className = "minor";
        }
        li.style.top = `${position * 100}%`;
        return li;
      }),
    );
  }
}

function clampZoom(zoom: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
}

/** Picker group of the layers of one kind. */
function optionGroup(
  label: string,
  layers: readonly DemoLayer[],
  kind: DemoLayer["kind"],
): HTMLOptGroupElement {
  const group = document.createElement("optgroup");
  group.label = label;
  group.append(
    ...layers
      .filter((l) => l.kind === kind)
      .map((l) => new Option(l.label, l.id)),
  );
  return group;
}

function isTintEntry(id: string | undefined): id is string {
  return TINT_LAYERS.some((l) => l.entryId === id);
}

function providerLabel(provider: string | undefined): string {
  return provider === "copernicus-marine" ? "Copernicus" : (provider ?? "");
}

function monthLabel(chunk: CatalogGeoVideoSource): string {
  const start = chunk.temporal?.start;
  if (!start) {
    return "—";
  }
  const date = new Date(start);
  const month = date.toLocaleDateString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
  return `${month} ’${String(date.getUTCFullYear()).slice(2)}`;
}

const root = document.getElementById("app");
if (root) {
  try {
    const demo = new ProjectionDemo(root);
    demo.load().catch((error: unknown) => {
      console.error(error);
      root.querySelector('[data-ref="status"]')!.textContent = String(error);
    });
  } catch (error) {
    console.error(error);
    root.querySelector('[data-ref="status"]')!.textContent = String(error);
  }
}
