import type { Map as MaplibreMap } from "maplibre-gl";
import type { Catalog, CatalogLayer } from "../catalog/types";
import { getPalettes, type ColorRampInput, type PaletteMeta } from "./gl-util";
import { ArcoLayer, buildWmtsLegendUrl } from "./ArcoLayer";
import { ZarrSource } from "./ZarrSource";
import type { ArcoLayerBackendPreference, FieldMeta, ZoomWeighted, ZarrPointSeriesResult } from "./types";

export interface ZartiglSettings {
  palette: ColorRampInput;
  particleDensity: number;
  speedFactor: ZoomWeighted;
  fadeOpacity: ZoomWeighted;
  dropRate: number;
  dropRateBump: number;
  opacity: number;
  logScale: boolean;
  vibrance: number;
}

export interface ZartiglOptions {
  id?: string;
  map: MaplibreMap;
  catalog: Catalog;
  backend?: "auto" | "zarr" | "wmts";
  visible?: boolean;
  settings?: Partial<ZartiglSettings>;
  metadata?: Record<string, unknown>;
  before?: string;
}

export interface TimeMeta {
  min: number;
  max: number;
  step?: number;
  size: number;
  values?: number[];
  units?: string;
  current?: number;
}

export interface DepthMeta {
  values: number[];
  label: "depth" | "pressure" | string;
  units?: string;
  current?: number;
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

type PublicBackend = "auto" | "zarr" | "wmts";

type ZartiglEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (err: Error) => void;
  frameBuffered: (ms: number) => void;
  cacheInvalidated: () => void;
};

function timeToMs(time: Date | string | number): number {
  return time instanceof Date ? time.getTime() : typeof time === "number" ? time : new Date(time).getTime();
}

function variableNames(catalogLayer: CatalogLayer): string[] {
  if (catalogLayer.kind === "scalar") return [catalogLayer.variables.value];
  if (catalogLayer.variables.derivation) {
    return [
      catalogLayer.variables.derivation.direction_variable,
      catalogLayer.variables.derivation.magnitude_variable,
    ];
  }
  return [catalogLayer.variables.u ?? "uo", catalogLayer.variables.v ?? "vo"];
}

function defaultDepth(catalogLayer: CatalogLayer): number {
  return sortedDepthValues(catalogLayer)[0] ?? catalogLayer.dimensions.vertical?.min ?? 0;
}

function defaultTime(catalogLayer: CatalogLayer): number {
  const dim = catalogLayer.dimensions.time;
  return dim.values?.[dim.values.length - 1] ?? dim.max ?? dim.min ?? 0;
}

function sortedDepthValues(catalogLayer: CatalogLayer): number[] {
  const dim = catalogLayer.dimensions.vertical;
  const values = [...(dim?.values ?? (dim?.min != null ? [dim.min] : []))];
  return values.sort((a, b) => {
    const da = Math.abs(a);
    const db = Math.abs(b);
    if (da !== db) return da - db;
    return b - a;
  });
}

function defaultSettings(catalogLayer?: CatalogLayer): Partial<ZartiglSettings> {
  const defaults = catalogLayer?.defaults;
  return {
    palette: defaults?.palette ?? "rdylbu",
    particleDensity: defaults?.particles?.density ?? 0.05,
    speedFactor: defaults?.particles?.speedFactor ?? 0.25,
    fadeOpacity: defaults?.particles?.fadeOpacity ?? 0.996,
    dropRate: defaults?.particles?.dropRate ?? 0.003,
    dropRateBump: defaults?.particles?.dropRateBump ?? 0.01,
    opacity: defaults?.raster?.opacity ?? 1,
    logScale: defaults?.raster?.logScale ?? false,
    vibrance: defaults?.raster?.vibrance ?? 0,
  };
}

export class Zartigl {
  private readonly id: string;
  private readonly map: MaplibreMap;
  private readonly catalog: Catalog;
  private readonly backendPreference: PublicBackend;
  private readonly metadata?: Record<string, unknown>;
  private readonly before?: string;
  private visible: boolean;
  private catalogLayer: CatalogLayer | null = null;
  private layer: ArcoLayer | null = null;
  private time: number = 0;
  private depth: number = 0;
  private settings: Partial<ZartiglSettings>;
  private lastMeta: FieldMeta | null = null;
  private destroyed = false;
  private attachQueued = false;
  private querySources = new Map<string, ZarrSource>();
  private listeners: Map<keyof ZartiglEventMap, Set<Function>> = new Map();

  private readonly onMapLoad = () => this.attachWhenReady();
  private readonly onStyleData = () => this.attachWhenReady();

  constructor(options: ZartiglOptions) {
    this.id = options.id ?? "zartigl";
    this.map = options.map;
    this.catalog = options.catalog;
    this.backendPreference = options.backend ?? "auto";
    this.metadata = options.metadata ? { ...options.metadata } : undefined;
    this.before = options.before;
    this.visible = options.visible ?? true;
    this.settings = { ...options.settings };

    this.map.on("load", this.onMapLoad);
    this.map.on("styledata", this.onStyleData);
  }

  async setLayer(id: string): Promise<void> {
    this.assertAlive();
    const catalogLayer = this.catalog.layers.find((candidate) => candidate.id === id);
    if (!catalogLayer) throw new Error(`Unknown zartigl catalog layer: ${id}`);

    this.detach();
    this.catalogLayer = catalogLayer;
    this.time = defaultTime(catalogLayer);
    this.depth = defaultDepth(catalogLayer);
    this.settings = { ...defaultSettings(catalogLayer), ...this.settings };
    this.lastMeta = null;
    this.attachWhenReady();
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

  destroy(): void {
    if (this.destroyed) return;
    this.detach();
    this.querySources.forEach((source) => source.cancelAll());
    this.querySources.clear();
    this.map.off("load", this.onMapLoad);
    this.map.off("styledata", this.onStyleData);
    this.destroyed = true;
  }

  setTime(time: Date | string | number): void {
    this.assertAlive();
    this.time = timeToMs(time);
    this.layer?.setTime(this.time);
  }

  setDepth(depth: number): void {
    this.assertAlive();
    this.depth = depth;
    this.layer?.setDepth(depth);
  }

  setTimeAndDepth(time: Date | string | number, depth: number): void {
    this.assertAlive();
    this.time = timeToMs(time);
    this.depth = depth;
    this.layer?.setTimeAndDepth(this.time, depth);
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

  getTimeMeta(): TimeMeta {
    if (!this.catalogLayer) return { min: NaN, max: NaN, size: 0, current: undefined };
    const dim = this.catalogLayer.dimensions.time;
    return {
      min: dim.min ?? dim.values?.[0] ?? NaN,
      max: dim.max ?? dim.values?.[dim.values.length - 1] ?? NaN,
      step: dim.step,
      size: dim.size,
      values: dim.values,
      units: dim.units,
      current: this.time,
    };
  }

  getDepthMeta(): DepthMeta {
    if (!this.catalogLayer?.dimensions.vertical) {
      return { values: [], label: "depth", current: undefined };
    }
    const dim = this.catalogLayer.dimensions.vertical;
    return {
      values: sortedDepthValues(this.catalogLayer),
      label: dim.label,
      units: dim.units,
      current: this.depth,
    };
  }

  getLegend(): Legend {
    if (!this.catalogLayer) return { type: "empty" };
    if (this.activeBackendPreference() === "wmts" && this.catalogLayer.stores.wmts) {
      const wmts = this.catalogLayer.stores.wmts;
      return {
        type: "image",
        url: buildWmtsLegendUrl({
          baseUrl: wmts.base_url,
          layer: wmts.layer,
          style: wmts.style,
        }),
        format: "image/svg+xml",
      };
    }
    const palette = typeof this.settings.palette === "string" ? this.settings.palette : "custom";
    return {
      type: "gradient",
      palette,
      min: this.lastMeta?.min,
      max: this.lastMeta?.max,
      unit: this.lastMeta?.unit ?? this.catalogLayer.variables.units,
    };
  }

  getPalettes(): PaletteMeta[] {
    return getPalettes();
  }

  getBackend(): "zarr" | "wmts" | undefined {
    if (!this.catalogLayer) return undefined;
    return this.activeBackendPreference() === "wmts" ? "wmts" : "zarr";
  }

  updateSettings(settings: Partial<ZartiglSettings>): void {
    this.assertAlive();
    const paletteChanged = settings.palette != null && settings.palette !== this.settings.palette;
    this.settings = { ...this.settings, ...settings };
    if (!this.layer) return;

    if (paletteChanged) {
      this.detach();
      this.attachWhenReady();
      return;
    }

    this.applyMutableSettings(this.layer, settings);
  }

  async queryTimeSeries(options: QueryPointOptions): Promise<ZarrPointSeriesResult> {
    this.assertAlive();
    const catalogLayer = this.requireLayer();
    const store = catalogLayer.stores.pointSeries;
    if (!store) throw new Error(`Catalog layer does not provide a point-series store: ${catalogLayer.id}`);

    const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? 512));
    const timeSize = catalogLayer.dimensions.time.size;
    const stride = Math.max(1, Math.ceil(timeSize / maxPoints));
    const source = this.getQuerySource(store.url);
    return source.sampleTimeSeries({
      variables: variableNames(catalogLayer),
      longitude: options.longitude,
      latitude: options.latitude,
      depth: options.depth ?? this.depth,
      stride,
      stopAfterMissingSamples: 12,
    });
  }

  async queryDepthProfile(options: QueryDepthProfileOptions): Promise<ZarrPointSeriesResult> {
    this.assertAlive();
    const catalogLayer = this.requireLayer();
    const store = catalogLayer.stores.pointSeries;
    if (!store) throw new Error(`Catalog layer does not provide a point-series store: ${catalogLayer.id}`);

    const source = this.getQuerySource(store.url);
    return source.sampleVerticalProfile({
      variables: variableNames(catalogLayer),
      longitude: options.longitude,
      latitude: options.latitude,
      time: options.time ?? this.time,
      maxDepths: Math.max(1, Math.floor(options.maxDepths ?? 32)),
      stopAfterMissingSamples: 8,
    });
  }

  private activeBackendPreference(): ArcoLayerBackendPreference {
    const catalogLayer = this.catalogLayer;
    if (!catalogLayer || catalogLayer.kind === "vector") return "zarr";
    if (this.backendPreference === "wmts") return catalogLayer.stores.wmts ? "wmts" : "zarr";
    if (this.backendPreference === "zarr") return "zarr";
    return catalogLayer.defaults?.backend === "wmts" && catalogLayer.stores.wmts ? "wmts" : "zarr";
  }

  private attachWhenReady(): void {
    if (this.destroyed || !this.visible || !this.catalogLayer) return;
    if (!this.isMapReady()) {
      this.attachQueued = true;
      return;
    }
    if (this.layer && this.map.getLayer(this.layer.id)) return;
    this.attachQueued = false;

    const layer = new ArcoLayer({
      id: this.id,
      layer: this.catalogLayer,
      backend: this.activeBackendPreference(),
      time: this.time,
      depth: this.depth,
      particleDensity: this.settings.particleDensity,
      speedFactor: this.settings.speedFactor,
      fadeOpacity: this.settings.fadeOpacity,
      dropRate: this.settings.dropRate,
      dropRateBump: this.settings.dropRateBump,
      opacity: this.settings.opacity,
      logScale: this.settings.logScale,
      vibrance: this.settings.vibrance,
      colorRamp: this.settings.palette,
      metadata: this.metadata ? { ...this.metadata } : undefined,
      before: this.before,
    });
    layer.on("loading", () => this.emit("loading"));
    layer.on("loaded", (meta) => {
      this.lastMeta = meta;
      this.emit("loaded", meta);
    });
    layer.on("error", (err) => this.emit("error", err));
    layer.on("frameBuffered", (ms) => this.emit("frameBuffered", ms));
    layer.on("cacheInvalidated", () => this.emit("cacheInvalidated"));
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

  private applyMutableSettings(layer: ArcoLayer, settings: Partial<ZartiglSettings>): void {
    if (settings.particleDensity != null) layer.setParticleDensity(settings.particleDensity);
    if (settings.speedFactor != null) layer.setSpeedFactor(settings.speedFactor);
    if (settings.fadeOpacity != null) layer.setFadeOpacity(settings.fadeOpacity);
    if (settings.dropRate != null) layer.setDropRate(settings.dropRate);
    if (settings.dropRateBump != null) layer.setDropRateBump(settings.dropRateBump);
    if (settings.opacity != null) layer.setOpacity(settings.opacity);
    if (settings.logScale != null) layer.setLogScale(settings.logScale);
    if (settings.vibrance != null) layer.setVibrance(settings.vibrance);
  }

  private getQuerySource(url: string): ZarrSource {
    let source = this.querySources.get(url);
    if (!source) {
      source = new ZarrSource(url, 80);
      this.querySources.set(url, source);
    }
    return source;
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

  private requireLayer(): CatalogLayer {
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
