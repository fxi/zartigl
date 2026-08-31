import type { Map as MaplibreMap } from "maplibre-gl";
import type { Catalog, CatalogEntry, CatalogSource, CatalogSourcePreference, CatalogWmtsSource, CatalogZarrSource } from "../catalog/types";
import { pickPreferredSource, resolveLocalizedText } from "../catalog";
import { getPalettes, type ColorRampInput, type PaletteMeta } from "./gl-util";
import { CatalogRenderLayer, buildWmtsLegendUrl } from "./CatalogRenderLayer";
import type { CatalogRenderLayerDebugInfo } from "./CatalogRenderLayer";
import { ZarrSource } from "./ZarrSource";
import type {
  FieldMeta,
  ZarrPointSeriesResult,
  ZarrTimeDimension,
  ZarrVerticalDimension,
} from "./types";
import type { ParticleStateMode, RenderMode } from "./ParticleSimulation";
import { validateScalarColorDomain } from "./scalar-color-domain";
import type { ZartiglStatus } from "./load-status";
import {
  geoVideoTimelineValues,
  loadGeoVideoManifest,
  type GeoVideoManifest,
} from "./geovideo";
import { loadWmtsCapabilities, type WmtsMetadata } from "./WmtsCapabilities";

export interface ZartiglSettings {
  palette: ColorRampInput;
  particleDensity: number;
  speed: number;
  fade: number;
  renderMode: RenderMode;
  opacity: number;
  logScale: boolean;
  vibrance: number;
  /** Fixed physical-value domain for scalar colors. Null uses frame extrema. */
  colorDomain: [number, number] | null;
  particleState: ParticleStateMode;
  rgba8MaxParticleZoom: number;
}

export interface ZartiglOptions {
  id?: string;
  map: MaplibreMap;
  catalog: Catalog;
  source?: CatalogSourcePreference;
  timeRange?: TimeRange;
  geoVideo?: GeoVideoOptions;
  visible?: boolean;
  settings?: Partial<ZartiglSettings>;
  metadata?: Record<string, unknown>;
  before?: string;
}

export interface GeoVideoOptions {
  autoplay?: boolean;
  loop?: boolean;
  playbackRate?: number;
}

export interface ZartiglDebugInfo {
  timestamp: string;
  userAgent?: string;
  id: string;
  destroyed: boolean;
  visible: boolean;
  suspended: boolean;
  sourcePreference: CatalogSourcePreference;
  activeSource?: { id: string; type: CatalogSource["type"] };
  projection?: string;
  canvasSize?: { width: number; height: number };
  canvasCssSize?: { width: number; height: number };
  devicePixelRatio?: number;
  catalogEntry: {
    id: string;
    title: string;
    kind: CatalogEntry["kind"];
  } | null;
  time: number;
  depth: number;
  settings: Partial<ZartiglSettings>;
  timeRange?: TimeRange;
  geoVideo: Required<GeoVideoOptions>;
  layer: CatalogRenderLayerDebugInfo | null;
}

export interface TimeMeta {
  min: number;
  max: number;
  step?: number;
  size: number;
  values: number[];
  units?: string;
  current?: number;
  granularity: TimeGranularity;
  timelineKind?: GeoVideoManifest["timeline"]["kind"];
}

export type TimeGranularity = "year" | "month" | "day" | "hour" | "minute" | "second";
export type TimeRange =
  | { start?: Date | string | number; end?: Date | string | number; trailing?: never }
  | { trailing: string; start?: never; end?: never };

export interface DepthMeta {
  values: number[];
  name?: string;
  label: "depth" | "pressure" | string;
  units?: string;
  current?: number;
}

export interface VariableMeta {
  standardName?: string;
  units?: string;
}

export type Legend =
  | {
      type: "gradient";
      palette: string;
      min?: number;
      max?: number;
      unit?: string;
    }
  | { type: "image"; url: string; format?: string }
  | { type: "empty" };

export interface QueryPointOptions {
  longitude: number;
  latitude: number;
  depth?: number;
  maxPoints?: number;
}

export interface QueryDepthProfileOptions {
  longitude: number;
  latitude: number;
  time?: string | number;
  maxDepths?: number;
}

type ZartiglEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (err: Error) => void;
  status: (status: ZartiglStatus) => void;
  frameBuffered: (ms: number) => void;
  cacheInvalidated: () => void;
  timeChange: (time: number) => void;
  playbackChange: (playing: boolean) => void;
};

function latestTimeAtOrBefore(values: readonly number[], now: number): number {
  if (values.length === 0) return now;
  let earliest = values[0];
  let latestPast: number | undefined;
  for (const value of values) {
    if (value < earliest) earliest = value;
    if (value <= now && (latestPast === undefined || value > latestPast)) {
      latestPast = value;
    }
  }
  return latestPast ?? earliest;
}

function timeToMs(time: Date | string | number): number {
  return time instanceof Date ? time.getTime() : typeof time === "number" ? time : new Date(time).getTime();
}

function parseTime(time: Date | string | number, label: string): number {
  const value = timeToMs(time);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function subtractIsoDuration(anchor: number, duration: string): number {
  const match = duration.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) throw new Error(`Invalid trailing time duration: ${duration}`);
  const values = match.slice(1).map((value) => Number(value ?? 0));
  if (!values.some((value) => value > 0)) {
    throw new Error("Trailing time duration must be positive");
  }
  const [years, months, weeks, days, hours, minutes, seconds] = values;
  const source = new Date(anchor);
  const monthIndex = source.getUTCFullYear() * 12 + source.getUTCMonth() - years * 12 - months;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
  return result - (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60_000 - seconds * 1000;
}

function inferTimeGranularity(values: readonly number[]): TimeGranularity {
  const dates = values.map((value) => new Date(value));
  const sameParts = (parts: Array<(date: Date) => number>) =>
    parts.every((part) => dates.every((date) => part(date) === part(dates[0])));
  const timeParts = [
    (date: Date) => date.getUTCHours(),
    (date: Date) => date.getUTCMinutes(),
    (date: Date) => date.getUTCSeconds(),
    (date: Date) => date.getUTCMilliseconds(),
  ];
  if (dates.length > 1) {
    if (sameParts([(d) => d.getUTCMonth(), (d) => d.getUTCDate(), ...timeParts])) return "year";
    if (sameParts([(d) => d.getUTCDate(), ...timeParts])) return "month";
    const steps = values.slice(1).map((value, index) => value - values[index]);
    if (sameParts(timeParts) && steps.every((step) => step % 86_400_000 === 0)) return "day";
    if (sameParts(timeParts.slice(1)) && steps.every((step) => step % 3_600_000 === 0)) return "hour";
    if (sameParts(timeParts.slice(2)) && steps.every((step) => step % 60_000 === 0)) return "minute";
    return "second";
  }
  const date = dates[0];
  if (!date) return "second";
  const midnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  if (midnight && date.getUTCMonth() === 0 && date.getUTCDate() === 1) return "year";
  if (midnight && date.getUTCDate() === 1) return "month";
  if (midnight) return "day";
  if (date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0) return "hour";
  if (date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0) return "minute";
  return "second";
}

function uniformStep(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const step = values[1] - values[0];
  return values.every((value, index) => index === 0 || value - values[index - 1] === step)
    ? step
    : undefined;
}

function resolveTimeRange(meta: ZarrTimeDimension, range?: TimeRange): [number, number] | null {
  if (!range) return null;
  const sourceMin = meta.values[0];
  const sourceMax = meta.values[meta.values.length - 1];
  let min = sourceMin;
  let max = sourceMax;
  if (typeof range.trailing === "string") {
    min = subtractIsoDuration(sourceMax, range.trailing);
  } else {
    if (range.start != null) min = parseTime(range.start, "time range start");
    if (range.end != null) max = parseTime(range.end, "time range end");
  }
  if (min > max) throw new Error("Time range start must not follow its end");
  return [Math.max(sourceMin, min), Math.min(sourceMax, max)];
}

function applyTimeRange(meta: ZarrTimeDimension, range?: TimeRange): ZarrTimeDimension {
  const resolved = resolveTimeRange(meta, range);
  if (!resolved) return meta;
  const [min, max] = resolved;
  const values = meta.values.filter((value) => value >= min && value <= max);
  if (values.length === 0) throw new Error("Time range does not contain any available timestamps");
  return {
    ...meta,
    min: values[0],
    max: values[values.length - 1],
    size: values.length,
    step: uniformStep(values),
    values,
  };
}

function variableNames(source: CatalogZarrSource): string[] {
  if (source.variables.kind === "scalar") return [source.variables.value];
  if (source.variables.derivation) {
    return [
      source.variables.derivation.direction_variable,
      source.variables.derivation.magnitude_variable,
    ];
  }
  return [source.variables.u ?? "uo", source.variables.v ?? "vo"];
}

function sortedDepthValues(values: readonly number[]): number[] {
  return [...values].sort((a, b) => {
    const da = Math.abs(a);
    const db = Math.abs(b);
    if (da !== db) return da - db;
    return b - a;
  });
}

function nearestValue(values: readonly number[], target: number): number {
  if (values.length === 0) return target;
  let nearest = values[0];
  let distance = Math.abs(nearest - target);
  for (let i = 1; i < values.length; i++) {
    const candidateDistance = Math.abs(values[i] - target);
    if (candidateDistance < distance) {
      nearest = values[i];
      distance = candidateDistance;
    }
  }
  return nearest;
}

function defaultSettings(catalogLayer?: CatalogEntry): Partial<ZartiglSettings> {
  const defaults = catalogLayer?.defaults;
  return {
    palette: defaults?.palette ?? "rdylbu",
    particleDensity: defaults?.particles?.density ?? 0.05,
    speed: defaults?.particles?.speed ?? 1.0,
    fade: defaults?.particles?.fade ?? 0.7,
    renderMode: catalogLayer?.kind === "scalar"
      ? "raster"
      : (defaults?.renderMode ?? "particles"),
    opacity: defaults?.raster?.opacity ?? 1,
    logScale: defaults?.raster?.logScale ?? false,
    vibrance: defaults?.raster?.vibrance ?? 0,
    colorDomain: validateScalarColorDomain(defaults?.raster?.colorDomain ?? null),
    particleState: "auto",
    rgba8MaxParticleZoom: 4,
  };
}

export class Zartigl {
  private readonly id: string;
  private readonly map: MaplibreMap;
  private readonly catalog: Catalog;
  private sourcePreference: CatalogSourcePreference;
  private timeRange?: TimeRange;
  private fullTimeMeta: ZarrTimeDimension | null = null;
  private readonly autoplay: boolean;
  private loop: boolean;
  private playbackRate: number;
  private readonly metadata?: Record<string, unknown>;
  private readonly before?: string;
  private visible: boolean;
  private catalogLayer: CatalogEntry | null = null;
  private catalogSource: CatalogSource | null = null;
  private layer: CatalogRenderLayer | null = null;
  private time: number = 0;
  private pendingTime: number | null = null;
  private depth: number = 0;
  private settings: Partial<ZartiglSettings>;
  private colorDomainOverridden: boolean;
  private lastMeta: FieldMeta | null = null;
  private timeMeta: ZarrTimeDimension | null = null;
  private resolvedTimeRange: [number, number] | null = null;
  private verticalMeta: ZarrVerticalDimension | null = null;
  private variableUnit = "";
  private variableStandardName: string | undefined;
  private geoVideoManifest: GeoVideoManifest | null = null;
  private wmtsMetadata: WmtsMetadata | null = null;
  private fieldSources = new Map<string, ZarrSource>();
  private activeFieldSource: ZarrSource | null = null;
  private switchGeneration = 0;
  private destroyed = false;
  private suspended = false;
  private attachQueued = false;
  private querySources = new Map<string, ZarrSource>();
  private listeners: Map<keyof ZartiglEventMap, Set<Function>> = new Map();

  private readonly onMapLoad = () => this.attachWhenReady();
  private readonly onStyleData = () => this.attachWhenReady();
  private readonly onMapIdle = () => this.attachWhenReady();

  constructor(options: ZartiglOptions) {
    this.id = options.id ?? "zartigl";
    this.map = options.map;
    this.catalog = options.catalog;
    this.sourcePreference = options.source ?? "auto";
    this.timeRange = options.timeRange ? { ...options.timeRange } : undefined;
    this.autoplay = options.geoVideo?.autoplay ?? true;
    this.loop = options.geoVideo?.loop ?? true;
    this.playbackRate = options.geoVideo?.playbackRate ?? 1;
    this.metadata = options.metadata ? { ...options.metadata } : undefined;
    this.before = options.before;
    this.visible = options.visible ?? true;
    this.settings = { ...options.settings };
    if (options.settings?.colorDomain !== undefined) {
      this.settings.colorDomain = validateScalarColorDomain(options.settings.colorDomain);
    }
    this.colorDomainOverridden = options.settings?.colorDomain !== undefined;

    this.map.on("load", this.onMapLoad);
    this.map.on("styledata", this.onStyleData);
    this.map.on("idle", this.onMapIdle);
  }

  async setLayer(id: string, preference: CatalogSourcePreference = this.sourcePreference): Promise<void> {
    this.assertAlive();
    const catalogLayer = this.catalog.layers.find((candidate) => candidate.id === id);
    if (!catalogLayer) throw new Error(`Unknown zartigl catalog entry: ${id}`);
    const layerDefaults = defaultSettings(catalogLayer);
    const requestedSource = this.resolveSource(catalogLayer, preference);

    const generation = ++this.switchGeneration;
    if (requestedSource.type === "geovideo") {
      this.emit("status", { phase: "metadata" });
      try {
        const manifest = await loadGeoVideoManifest(requestedSource.manifestUrl);
        const inputSource = catalogLayer.sources.find((source) => source.id === manifest.provenance.inputSourceId);
        if (manifest.id !== requestedSource.id || manifest.provenance.catalogEntryId !== catalogLayer.id || inputSource?.type !== "zarr") {
          throw new Error(`GeoVideo manifest identity does not match catalog entry/source: ${requestedSource.id}`);
        }
        if (generation !== this.switchGeneration) {
          throw new DOMException("Layer selection was superseded", "AbortError");
        }
        const values = geoVideoTimelineValues(manifest);
        const geoVideoTimeMeta = {
          min: values[0],
          max: values[values.length - 1],
          step: values.length > 1 ? values[1] - values[0] : undefined,
          size: values.length,
          units: "milliseconds since 1970-01-01T00:00:00Z",
          values,
        };
        const resolvedTimeRange = resolveTimeRange(geoVideoTimeMeta, this.timeRange);
        const filteredTimeMeta = applyTimeRange(geoVideoTimeMeta, this.timeRange);
        this.detach();
        this.catalogLayer = catalogLayer;
        this.catalogSource = requestedSource;
        this.sourcePreference = preference;
        this.activeFieldSource = null;
        this.geoVideoManifest = manifest;
        this.wmtsMetadata = null;
        this.fullTimeMeta = geoVideoTimeMeta;
        this.resolvedTimeRange = resolvedTimeRange;
        this.timeMeta = filteredTimeMeta;
        this.verticalMeta = null;
        this.variableUnit = manifest.style.unit ?? "";
        this.variableStandardName = manifest.provenance.variables[0];
        this.time = this.pendingTime == null
          ? this.timeMeta.values[0]
          : nearestValue(this.timeMeta.values, this.pendingTime);
        this.pendingTime = null;
        this.depth = 0;
        const overriddenColorDomain = this.settings.colorDomain;
        this.settings = { ...layerDefaults, ...this.settings };
        this.settings.colorDomain = this.colorDomainOverridden
          ? (overriddenColorDomain ?? null)
          : manifest.style.colorDomain;
        this.settings.palette = manifest.style.palette;
        this.lastMeta = null;
        this.attachWhenReady();
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.name !== "AbortError") {
          this.emit("status", { phase: "error", error: err });
          this.emit("error", err);
        }
        throw err;
      }
    }

    if (requestedSource.type === "wmts") {
      this.emit("status", { phase: "metadata" });
      try {
        const metadata = await loadWmtsCapabilities(requestedSource);
        if (generation !== this.switchGeneration) throw new DOMException("Layer selection was superseded", "AbortError");
        const fullTimeMeta = metadata.time;
        const timeMeta = applyTimeRange(fullTimeMeta, this.timeRange);
        this.detach();
        this.catalogLayer = catalogLayer;
        this.catalogSource = {
          ...requestedSource,
          baseUrl: metadata.baseUrl,
          tileUrlTemplate: requestedSource.tileUrlTemplate ?? metadata.tileUrlTemplate,
          tileMatrixSet: metadata.tileMatrixSet,
          format: metadata.format,
          style: requestedSource.style ?? metadata.style,
        };
        this.sourcePreference = preference;
        this.activeFieldSource = null;
        this.geoVideoManifest = null;
        this.wmtsMetadata = metadata;
        this.fullTimeMeta = fullTimeMeta;
        this.resolvedTimeRange = resolveTimeRange(fullTimeMeta, this.timeRange);
        this.timeMeta = timeMeta;
        this.verticalMeta = metadata.vertical;
        this.variableUnit = "";
        this.variableStandardName = requestedSource.layer;
        this.time = this.pendingTime == null ? latestTimeAtOrBefore(timeMeta.values, Date.now()) : nearestValue(timeMeta.values, this.pendingTime);
        this.pendingTime = null;
        this.depth = sortedDepthValues(metadata.vertical?.values ?? [0])[0] ?? 0;
        this.settings = { ...layerDefaults, ...this.settings };
        this.lastMeta = null;
        this.attachWhenReady();
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.name !== "AbortError") { this.emit("status", { phase: "error", error: err }); this.emit("error", err); }
        throw err;
      }
    }

    const source = this.getFieldSource(requestedSource.endpoints.field);
    let timeMeta: ZarrTimeDimension;
    let fullTimeMeta: ZarrTimeDimension;
    let resolvedTimeRange: [number, number] | null;
    let verticalMeta: ZarrVerticalDimension | null;
    let unitAttrs: ReturnType<ZarrSource["getVariableAttrs"]>;
    this.emit("status", { phase: "metadata" });
    try {
      await source.init();
      const configuredVariables = variableNames(requestedSource);
      for (const variable of configuredVariables) {
        if (!source.hasVariable(variable)) {
          throw new Error(`Configured variable not found in Zarr store: ${variable}`);
        }
      }
      fullTimeMeta = source.getTimeDimension();
      if (fullTimeMeta.values.length === 0) throw new Error("Zarr time coordinate is empty");
      resolvedTimeRange = resolveTimeRange(fullTimeMeta, this.timeRange);
      timeMeta = applyTimeRange(fullTimeMeta, this.timeRange);
      verticalMeta = source.getVerticalDimension(configuredVariables[0]) ?? null;
      unitAttrs = source.getVariableAttrs(configuredVariables[configuredVariables.length - 1]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("status", { phase: "error", error: err });
      this.emit("error", err);
      throw err;
    }
    if (generation !== this.switchGeneration) {
      throw new DOMException("Layer selection was superseded", "AbortError");
    }

    this.detach();
    this.catalogLayer = catalogLayer;
    this.catalogSource = requestedSource;
    this.sourcePreference = preference;
    this.activeFieldSource = source;
    this.geoVideoManifest = null;
    this.wmtsMetadata = null;
    this.fullTimeMeta = fullTimeMeta;
    this.resolvedTimeRange = resolvedTimeRange;
    this.timeMeta = timeMeta;
    this.verticalMeta = verticalMeta;
    this.variableUnit = typeof unitAttrs.units === "string" ? unitAttrs.units : "";
    this.variableStandardName = typeof unitAttrs.standard_name === "string"
      ? unitAttrs.standard_name
      : undefined;
    this.time = latestTimeAtOrBefore(this.timeMeta.values, Date.now());
    this.depth = sortedDepthValues(verticalMeta?.values ?? [0])[0] ?? 0;
    const overriddenColorDomain = this.settings.colorDomain;
    this.settings = { ...layerDefaults, ...this.settings };
    this.settings.colorDomain = this.colorDomainOverridden
      ? (overriddenColorDomain ?? null)
      : (layerDefaults.colorDomain ?? null);
    this.lastMeta = null;
    this.attachWhenReady();
  }

  async setSource(preference: CatalogSourcePreference): Promise<void> {
    this.assertAlive();
    if (!this.catalogLayer) {
      this.sourcePreference = preference;
      return;
    }
    this.pendingTime = this.time;
    await this.setLayer(this.catalogLayer.id, preference);
  }

  show(): void {
    this.assertAlive();
    if (this.visible) return;
    this.visible = true;
    this.attachWhenReady();
  }

  hide(): void {
    this.assertAlive();
    if (!this.visible) return;
    this.visible = false;
    this.detach();
  }

  /** Pause rendering and abort field requests without discarding layer state. */
  suspend(): void {
    this.assertAlive();
    if (this.suspended) return;
    this.suspended = true;
    this.layer?.suspend();
    this.querySources.forEach((source) => source.cancelAll());
    this.fieldSources.forEach((source) => source.cancelAll());
  }

  /** Resume rendering and load only the latest requested time/depth state. */
  resume(): void {
    this.assertAlive();
    if (!this.suspended) return;
    this.suspended = false;
    if (this.layer) {
      this.layer.resume();
      return;
    }
    this.attachWhenReady();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.switchGeneration++;
    this.detach();
    this.querySources.forEach((source) => source.cancelAll());
    this.fieldSources.forEach((source) => source.cancelAll());
    this.querySources.clear();
    this.fieldSources.clear();
    this.map.off("load", this.onMapLoad);
    this.map.off("styledata", this.onStyleData);
    this.map.off("idle", this.onMapIdle);
    this.destroyed = true;
  }

  setTime(time: Date | string | number): void {
    this.assertAlive();
    const requested = timeToMs(time);
    if (!this.layer) this.pendingTime = requested;
    this.time = nearestValue(this.timeMeta?.values ?? [], requested);
    this.layer?.setTime(this.time);
  }

  async play(): Promise<void> {
    this.assertAlive();
    await this.layer?.play();
  }

  pause(): void {
    this.assertAlive();
    this.layer?.pause();
  }

  setLoop(loop: boolean): void {
    this.assertAlive();
    this.loop = loop;
    this.layer?.setLoop(loop);
  }

  setPlaybackRate(rate: number): void {
    this.assertAlive();
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("Playback rate must be positive");
    this.playbackRate = rate;
    this.layer?.setPlaybackRate(rate);
  }

  /** Apply or clear a time window without rebuilding source metadata or the map layer. */
  setTimeRange(range?: TimeRange | null): TimeMeta {
    this.assertAlive();
    if (!this.fullTimeMeta) throw new Error("Set a layer before changing its time range");

    const nextRange = range == null ? undefined : { ...range };
    const nextResolved = resolveTimeRange(this.fullTimeMeta, nextRange);
    const nextMeta = applyTimeRange(this.fullTimeMeta, nextRange);
    const nextTime = nearestValue(nextMeta.values, this.time);

    this.timeRange = nextRange;
    this.resolvedTimeRange = nextResolved;
    this.timeMeta = nextMeta;
    this.time = nextTime;
    this.layer?.setTimeRange([nextMeta.min, nextMeta.max]);
    this.layer?.setTime(nextTime);
    return this.getTimeMeta();
  }

  setDepth(depth: number): void {
    this.assertAlive();
    this.depth = nearestValue(this.verticalMeta?.values ?? [], depth);
    this.layer?.setDepth(this.depth);
  }

  setTimeAndDepth(time: Date | string | number, depth: number): void {
    this.assertAlive();
    this.time = nearestValue(this.timeMeta?.values ?? [], timeToMs(time));
    this.depth = nearestValue(this.verticalMeta?.values ?? [], depth);
    this.layer?.setTimeAndDepth(this.time, this.depth);
  }

  on<K extends keyof ZartiglEventMap>(event: K, handler: ZartiglEventMap[K]): this {
    this.assertAlive();
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof ZartiglEventMap>(event: K, handler: ZartiglEventMap[K]): this {
    this.assertAlive();
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  getTimeMeta(options: { full?: boolean } = {}): TimeMeta {
    const dim = options.full ? this.fullTimeMeta : this.timeMeta;
    if (!dim) {
      return {
        min: NaN,
        max: NaN,
        size: 0,
        values: [],
        current: undefined,
        granularity: "second",
      };
    }
    return {
      min: dim.min,
      max: dim.max,
      step: dim.step,
      size: dim.size,
      values: dim.values,
      units: dim.units,
      current: this.time,
      granularity: inferTimeGranularity(dim.values),
      timelineKind: this.geoVideoManifest?.timeline.kind,
    };
  }

  getDepthMeta(): DepthMeta {
    if (!this.verticalMeta) {
      return { values: [], label: "depth", current: undefined };
    }
    const dim = this.verticalMeta;
    return {
      values: sortedDepthValues(dim.values),
      name: dim.name,
      label: dim.label,
      units: dim.units,
      current: this.depth,
    };
  }

  getVariableMeta(): VariableMeta {
    return {
      standardName: this.variableStandardName,
      units: this.variableUnit || undefined,
    };
  }

  getLegend(): Legend {
    if (!this.catalogLayer || !this.catalogSource) return { type: "empty" };
    if (this.catalogSource.type === "wmts") {
      const wmts = this.catalogSource;
      return {
        type: "image",
        url: buildWmtsLegendUrl({
          baseUrl: wmts.baseUrl ?? this.wmtsMetadata?.baseUrl ?? new URL(wmts.capabilitiesUrl).origin,
          layer: wmts.layer,
          style: wmts.style,
        }),
        format: "image/svg+xml",
      };
    }
    if (this.catalogSource.type === "geovideo" && this.geoVideoManifest) {
      const palette = typeof this.settings.palette === "string" ? this.settings.palette : "custom";
      const colorDomain = this.settings.colorDomain ?? this.geoVideoManifest.style.colorDomain;
      return {
        type: "gradient",
        palette,
        min: colorDomain[0],
        max: colorDomain[1],
        unit: this.geoVideoManifest.style.unit,
      };
    }
    const palette = typeof this.settings.palette === "string" ? this.settings.palette : "custom";
    const colorDomain = this.catalogLayer.kind === "scalar" ? this.settings.colorDomain : null;
    return {
      type: "gradient",
      palette,
      min: colorDomain?.[0] ?? this.lastMeta?.min,
      max: colorDomain?.[1] ?? this.lastMeta?.max,
      unit: this.lastMeta?.unit ?? this.variableUnit,
    };
  }

  getPalettes(): PaletteMeta[] {
    return getPalettes();
  }

  getSource(): { id: string; type: CatalogSource["type"] } | undefined {
    return this.catalogSource ? { id: this.catalogSource.id, type: this.catalogSource.type } : undefined;
  }

  getCapabilities(): { render: true; time: boolean; depth: boolean; pointQuery: boolean; sourceTypes: CatalogSource["type"][] } {
    const entry = this.catalogLayer;
    const querySource = entry ? this.querySource(entry) : undefined;
    return { render: true, time: !!this.timeMeta?.values.length, depth: !!this.verticalMeta?.values.length,
      pointQuery: !!querySource, sourceTypes: entry ? [...new Set(entry.sources.map((source) => source.type))] : [] };
  }

  /** Whether palette/domain styling is applied to values in the active renderer. */
  supportsDynamicStyle(): boolean {
    return this.catalogSource?.type === "zarr" || this.catalogSource?.type === "geovideo";
  }

  getDebugInfo(): ZartiglDebugInfo {
    const canvas = this.map.getCanvas?.();
    return {
      timestamp: new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      id: this.id,
      destroyed: this.destroyed,
      visible: this.visible,
      suspended: this.suspended,
      sourcePreference: this.sourcePreference,
      activeSource: this.getSource(),
      projection: String(this.map.getProjection?.()?.type ?? ""),
      canvasSize: canvas ? { width: canvas.width, height: canvas.height } : undefined,
      canvasCssSize: canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : undefined,
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : undefined,
      catalogEntry: this.catalogLayer ? {
        id: this.catalogLayer.id,
        title: resolveLocalizedText(this.catalogLayer.title, this.catalog.defaultLocale, this.catalog.defaultLocale),
        kind: this.catalogLayer.kind,
      } : null,
      time: this.time,
      depth: this.depth,
      settings: { ...this.settings },
      timeRange: this.timeRange ? { ...this.timeRange } : undefined,
      geoVideo: {
        autoplay: this.autoplay,
        loop: this.loop,
        playbackRate: this.playbackRate,
      },
      layer: this.layer?.getDebugInfo() ?? null,
    };
  }

  updateSettings(settings: Partial<ZartiglSettings>): void {
    this.assertAlive();
    const validatedSettings = settings.colorDomain === undefined
      ? settings
      : {
          ...settings,
          colorDomain: validateScalarColorDomain(settings.colorDomain),
        };
    const paletteChanged = validatedSettings.palette != null &&
      validatedSettings.palette !== this.settings.palette;
    const particleStateChanged =
      validatedSettings.particleState != null &&
      validatedSettings.particleState !== this.settings.particleState;
    if (validatedSettings.colorDomain !== undefined) this.colorDomainOverridden = true;
    this.settings = { ...this.settings, ...validatedSettings };
    if (!this.layer) return;

    if (paletteChanged && this.catalogSource?.type === "geovideo") {
      this.layer.setColorRamp(validatedSettings.palette!);
      this.applyMutableSettings(this.layer, validatedSettings);
      return;
    }

    if (paletteChanged || particleStateChanged) {
      this.detach();
      this.attachWhenReady();
      return;
    }

    this.applyMutableSettings(this.layer, validatedSettings);
  }

  async queryTimeSeries(options: QueryPointOptions): Promise<ZarrPointSeriesResult> {
    this.assertAlive();
    const catalogLayer = this.requireLayer();
    const queryConfig = this.querySource(catalogLayer);
    if (!queryConfig) throw new Error(`Catalog entry does not provide point-query capability: ${catalogLayer.id}`);

    const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? 512));
    const source = this.getQuerySource(queryConfig.endpoints.pointSeries!);
    await source.init();
    const queryTimes = source.getTimeDimension().values;
    if (!this.timeRange) {
      const stride = Math.max(1, Math.ceil(queryTimes.length / maxPoints));
      return source.sampleTimeSeries({
        variables: variableNames(queryConfig),
        longitude: options.longitude,
        latitude: options.latitude,
        depth: options.depth ?? this.depth,
        stride,
        stopAfterMissingSamples: 12,
      });
    }
    const min = this.resolvedTimeRange?.[0] ?? this.timeMeta?.min ?? queryTimes[0];
    const max = this.resolvedTimeRange?.[1] ?? this.timeMeta?.max ?? queryTimes[queryTimes.length - 1];
    const startIndex = queryTimes.findIndex((value) => value >= min);
    let endIndex = queryTimes.length - 1;
    while (endIndex >= 0 && queryTimes[endIndex] > max) endIndex--;
    if (startIndex < 0 || endIndex < startIndex) {
      throw new Error("Time range does not overlap the point-series store");
    }
    const stride = Math.max(1, Math.ceil((endIndex - startIndex + 1) / maxPoints));
    return source.sampleTimeSeries({
      variables: variableNames(queryConfig),
      longitude: options.longitude,
      latitude: options.latitude,
      depth: options.depth ?? this.depth,
      timeStartIndex: startIndex,
      timeEndIndex: endIndex,
      stride,
      stopAfterMissingSamples: 12,
    });
  }

  async queryDepthProfile(options: QueryDepthProfileOptions): Promise<ZarrPointSeriesResult> {
    this.assertAlive();
    const catalogLayer = this.requireLayer();
    const queryConfig = this.querySource(catalogLayer);
    if (!queryConfig) throw new Error(`Catalog entry does not provide point-query capability: ${catalogLayer.id}`);

    const source = this.getQuerySource(queryConfig.endpoints.pointSeries!);
    return source.sampleVerticalProfile({
      variables: variableNames(queryConfig),
      longitude: options.longitude,
      latitude: options.latitude,
      time: options.time ?? this.time,
      maxDepths: Math.max(1, Math.floor(options.maxDepths ?? 32)),
      stopAfterMissingSamples: 8,
    });
  }

  private attachWhenReady(): void {
    if (this.destroyed || this.suspended || !this.visible || !this.catalogLayer || !this.catalogSource) return;
    if (!this.isMapReady()) {
      this.attachQueued = true;
      return;
    }
    if (this.layer && this.map.getLayer(this.layer.id)) return;
    this.attachQueued = false;

    const layer = new CatalogRenderLayer({
      id: this.id,
      entry: this.catalogLayer,
      sourceConfig: this.catalogSource,
      time: this.time,
      depth: this.depth,
      particleDensity: this.settings.particleDensity,
      speed: this.settings.speed,
      fade: this.settings.fade,
      renderMode: this.settings.renderMode,
      opacity: this.settings.opacity,
      logScale: this.settings.logScale,
      vibrance: this.settings.vibrance,
      colorDomain: this.settings.colorDomain,
      geoVideoManifest: this.geoVideoManifest ?? undefined,
      geoVideoAutoplay: this.autoplay,
      geoVideoLoop: this.loop,
      geoVideoPlaybackRate: this.playbackRate,
      geoVideoTimeRange: this.timeMeta ? [this.timeMeta.min, this.timeMeta.max] : undefined,
      particleState: this.settings.particleState,
      rgba8MaxParticleZoom: this.settings.rgba8MaxParticleZoom,
      zarrSource: this.activeFieldSource ?? undefined,
      unit: this.variableUnit,
      verticalLabel: this.verticalMeta?.label,
      colorRamp: this.settings.palette,
      metadata: this.metadata ? { ...this.metadata } : undefined,
      before: this.before,
    });
    this.pendingTime = null;
    layer.on("loading", () => this.emit("loading"));
    layer.on("loaded", (meta) => {
      this.lastMeta = meta;
      this.emit("loaded", meta);
    });
    layer.on("error", (err) => this.emit("error", err));
    layer.on("status", (status) => this.emit("status", status));
    layer.on("frameBuffered", (ms) => this.emit("frameBuffered", ms));
    layer.on("cacheInvalidated", () => this.emit("cacheInvalidated"));
    layer.on("timeChange", (time) => {
      this.time = nearestValue(this.timeMeta?.values ?? [], time);
      this.emit("timeChange", this.time);
    });
    layer.on("playbackChange", (playing) => this.emit("playbackChange", playing));
    this.layer = layer;
    const before = this.getBeforeLayerId();
    if (before) {
      this.map.addLayer(layer, before);
      return;
    }
    this.map.addLayer(layer);
  }

  private detach(): void {
    const layerId = this.layer?.id ?? this.id;
    const wmtsLayerId = `${layerId}-wmts`;
    const wmtsSourceId = `${layerId}-wmts-source`;

    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getLayer(wmtsLayerId)) this.map.removeLayer(wmtsLayerId);
    if (this.map.getSource(wmtsSourceId)) this.map.removeSource(wmtsSourceId);
    this.layer = null;
  }

  private applyMutableSettings(layer: CatalogRenderLayer, settings: Partial<ZartiglSettings>): void {
    if (settings.particleDensity != null) layer.setParticleDensity(settings.particleDensity);
    if (settings.speed != null) layer.setSpeed(settings.speed);
    if (settings.fade != null) layer.setFade(settings.fade);
    if (settings.renderMode != null) layer.setRenderMode(settings.renderMode);
    if (settings.opacity != null) layer.setOpacity(settings.opacity);
    if (settings.logScale != null) layer.setLogScale(settings.logScale);
    if (settings.vibrance != null) layer.setVibrance(settings.vibrance);
    if (settings.colorDomain !== undefined) layer.setColorDomain(settings.colorDomain);
    if (settings.rgba8MaxParticleZoom != null) {
      layer.setRgba8MaxParticleZoom(settings.rgba8MaxParticleZoom);
    }
  }

  private getQuerySource(url: string): ZarrSource {
    let source = this.querySources.get(url);
    if (!source) {
      source = new ZarrSource(url, 80);
      this.querySources.set(url, source);
    }
    return source;
  }

  private getFieldSource(url: string): ZarrSource {
    let source = this.fieldSources.get(url);
    if (!source) {
      source = new ZarrSource(url);
      this.fieldSources.set(url, source);
    }
    return source;
  }

  private resolveSource(entry: CatalogEntry, preference: CatalogSourcePreference): CatalogSource {
    const selected = preference === "auto"
      ? pickPreferredSource(entry)
      : entry.sources.find((source) => source.id === preference) ?? entry.sources.find((source) => source.type === preference);
    if (!selected) throw new Error(`Catalog entry ${entry.id} does not provide source: ${preference}`);
    if (entry.kind === "vector" && selected.type !== "zarr") {
      throw new Error(`Vector catalog entry ${entry.id} requires a Zarr source`);
    }
    return selected;
  }

  private querySource(entry: CatalogEntry): CatalogZarrSource | undefined {
    const configured = entry.defaults.querySourceId
      ? entry.sources.find((source) => source.id === entry.defaults.querySourceId)
      : undefined;
    if (configured?.type === "zarr" && configured.endpoints.pointSeries) return configured;
    return entry.sources.find((source): source is CatalogZarrSource => source.type === "zarr" && !!source.endpoints.pointSeries);
  }

  private isMapReady(): boolean {
    const map = this.map as MaplibreMap & {
      isStyleLoaded?: () => boolean;
      loaded?: () => boolean;
    };
    return map.isStyleLoaded?.() ?? map.loaded?.() ?? true;
  }

  private getBeforeLayerId(): string | undefined {
    if (!this.before || !this.map.getLayer(this.before)) return undefined;
    return this.before;
  }

  private requireLayer(): CatalogEntry {
    if (!this.catalogLayer) throw new Error("Call setLayer() before querying");
    return this.catalogLayer;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Zartigl instance has been destroyed");
    if (this.attachQueued) {
      this.attachQueued = false;
      this.attachWhenReady();
    }
  }

  private emit<K extends keyof ZartiglEventMap>(
    event: K,
    ...args: Parameters<ZartiglEventMap[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        (handler as Function)(...args);
      }
    }
  }
}
