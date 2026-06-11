import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";
import { ScalarLayer } from "./ScalarLayer";
import { VectorLayer } from "./VectorLayer";
import type {
  ArcoLayerBackend,
  ArcoLayerOptions,
  FieldMeta,
  ZoomWeighted,
} from "./types";
import type { ColorRampInput } from "./gl-util";
import type { CatalogLayer } from "../catalog/types";

type LayerEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (err: Error) => void;
  frameBuffered: (ms: number) => void;
  cacheInvalidated: () => void;
};

function toIsoTime(time: string | number): string {
  return typeof time === "string" ? time : new Date(time).toISOString();
}

function encodeParam(value: string | number): string {
  return encodeURIComponent(String(value));
}

function wmtsElevation(depth: number, verticalLabel?: string): number {
  return verticalLabel === "depth" ? -Math.abs(depth) : depth;
}

export function buildWmtsTileUrl(options: {
  baseUrl: string;
  layer: string;
  tileMatrixSet: string;
  format: string;
  style?: string;
  time?: string | number;
  depth?: number;
  verticalLabel?: string;
}): string {
  const params = [
    ["SERVICE", "WMTS"],
    ["VERSION", "1.0.0"],
    ["REQUEST", "GetTile"],
    ["LAYER", options.layer],
    ["FORMAT", options.format],
    ["TILEMATRIXSET", options.tileMatrixSet],
    ["TILEMATRIX", "{z}"],
    ["TILEROW", "{y}"],
    ["TILECOL", "{x}"],
  ];

  if (options.style) params.push(["STYLE", options.style]);
  if (options.time != null) params.push(["time", toIsoTime(options.time)]);
  if (options.depth != null) {
    params.push(["elevation", String(wmtsElevation(options.depth, options.verticalLabel))]);
  }

  const query = params
    .map(([key, value]) => `${key}=${value.startsWith("{") ? value : encodeParam(value)}`)
    .join("&");
  return `${options.baseUrl}?${query}`;
}

export function buildWmtsLegendUrl(options: {
  baseUrl: string;
  layer: string;
  format?: string;
  style?: string;
}): string {
  const params = [
    ["SERVICE", "WMTS"],
    ["REQUEST", "GetLegend"],
    ["LAYER", options.layer],
    ["FORMAT", options.format ?? "image/svg+xml"],
  ];
  if (options.style) params.push(["STYLE", options.style]);
  return `${options.baseUrl}?${params.map(([key, value]) => `${key}=${encodeParam(value)}`).join("&")}`;
}

export function selectArcoLayerBackend(options: ArcoLayerOptions): ArcoLayerBackend {
  if (options.layer.kind === "vector") return "vector";
  if (options.backend === "wmts" && options.layer.stores.wmts) return "scalar-wmts";
  return "scalar-zarr";
}

function layerUnit(catalogLayer: CatalogLayer): string {
  return catalogLayer.variables.units ?? "";
}

function scalarLayerVariable(catalogLayer: CatalogLayer): string {
  return catalogLayer.variables.kind === "scalar" ? catalogLayer.variables.value : "scalar";
}

function vectorLayerU(catalogLayer: CatalogLayer): string {
  return catalogLayer.variables.kind === "vector" ? (catalogLayer.variables.u ?? "uo") : "uo";
}

function vectorLayerV(catalogLayer: CatalogLayer): string {
  return catalogLayer.variables.kind === "vector" ? (catalogLayer.variables.v ?? "vo") : "vo";
}

function vectorLayerDerivation(catalogLayer: CatalogLayer) {
  return catalogLayer.variables.kind === "vector" ? catalogLayer.variables.derivation : undefined;
}

export class ArcoLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  readonly metadata?: Record<string, unknown>;

  private readonly options: ArcoLayerOptions;
  private readonly backend: ArcoLayerBackend;
  private delegate: ScalarLayer | VectorLayer | null = null;
  private map: MaplibreMap | null = null;
  private rasterSourceId: string;
  private rasterLayerId: string;
  private time: string | number;
  private depth: number;
  private opacity: number;
  private listeners: Map<string, Set<Function>> = new Map();

  constructor(options: ArcoLayerOptions) {
    this.options = options;
    this.id = options.id;
    this.metadata = options.metadata ? { ...options.metadata } : undefined;
    this.backend = selectArcoLayerBackend(options);
    this.rasterSourceId = `${options.id}-wmts-source`;
    this.rasterLayerId = `${options.id}-wmts`;
    this.time = options.time ?? 0;
    this.depth = options.depth ?? 0;
    this.opacity = options.opacity ?? 1;

    if (this.backend === "vector") {
      const catalogLayer = options.layer;
      this.delegate = new VectorLayer({
        ...options,
        source: catalogLayer.stores.field.url,
        variableU: vectorLayerU(catalogLayer),
        variableV: vectorLayerV(catalogLayer),
        vectorDerivation: vectorLayerDerivation(catalogLayer),
        unit: layerUnit(catalogLayer),
      });
    } else if (this.backend === "scalar-zarr") {
      const catalogLayer = options.layer;
      this.delegate = new ScalarLayer({
        id: options.id,
        source: catalogLayer.stores.field.url,
        variable: scalarLayerVariable(catalogLayer),
        time: options.time,
        depth: options.depth,
        colorRamp: options.colorRamp,
        opacity: options.opacity,
        logScale: options.logScale,
        vibrance: options.vibrance,
        unit: layerUnit(catalogLayer),
      });
    }
  }

  getBackend(): ArcoLayerBackend {
    return this.backend;
  }

  onAdd(map: MaplibreMap, gl: WebGLRenderingContext): void | Promise<void> {
    this.map = map;
    if (this.delegate) return this.delegate.onAdd(map, gl);
    this.addOrUpdateWmts();
    this.emitLoaded();
  }

  render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
    this.delegate?.render(gl, options);
  }

  onRemove(): void {
    this.delegate?.onRemove();
    this.removeWmts();
    this.map = null;
  }

  setTime(time: string | number): void {
    this.time = time;
    if (this.delegate) {
      this.delegate.setTime(time);
      return;
    }
    this.addOrUpdateWmts();
    this.emitLoaded();
  }

  setTimeAndDepth(time: string | number, depth: number): void {
    this.time = time;
    this.depth = depth;
    if (this.delegate) {
      this.delegate.setTimeAndDepth(time, depth);
      return;
    }
    this.addOrUpdateWmts();
    this.emitLoaded();
  }

  setDepth(depth: number): void {
    this.depth = depth;
    if (this.delegate) {
      this.delegate.setDepth(depth);
      return;
    }
    this.addOrUpdateWmts();
    this.emitLoaded();
  }

  async prefetchTime(ms: number): Promise<void> {
    await this.delegate?.prefetchTime(ms);
  }

  isFrameCached(ms: number): boolean {
    return this.delegate?.isFrameCached(ms) ?? false;
  }

  cancelPrefetches(): void {
    this.delegate?.cancelPrefetches();
  }

  setSpeedFactor(v: ZoomWeighted): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setSpeedFactor(v);
  }

  setFadeOpacity(v: ZoomWeighted): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setFadeOpacity(v);
  }

  setDropRate(v: number): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setDropRate(v);
  }

  setDropRateBump(v: number): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setDropRateBump(v);
  }

  setParticleDensity(density: number): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setParticleDensity(density);
  }

  setColorRamp(ramp: ColorRampInput): void {
    this.delegate?.setColorRamp(ramp);
  }

  setOpacity(v: number): void {
    this.opacity = v;
    if (this.delegate) {
      this.delegate.setOpacity(v);
      return;
    }
    if (this.map?.getLayer(this.rasterLayerId)) {
      this.map.setPaintProperty(this.rasterLayerId, "raster-opacity", v);
    }
  }

  setLogScale(v: boolean): void {
    if (this.delegate instanceof ScalarLayer) this.delegate.setLogScale(v);
    if (this.delegate instanceof VectorLayer) this.delegate.setLogScale(v);
  }

  setVibrance(v: number): void {
    this.delegate?.setVibrance(v);
  }

  async samplePoint(options: { longitude: number; latitude: number; time?: string | number; depth?: number }) {
    if (this.delegate instanceof ScalarLayer) return this.delegate.samplePoint(options);
    return undefined;
  }

  on<K extends keyof LayerEventMap>(event: K, handler: LayerEventMap[K]): this {
    this.delegate?.on(event, handler);
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof LayerEventMap>(event: K, handler: LayerEventMap[K]): this {
    this.delegate?.off(event, handler);
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  private addOrUpdateWmts(): void {
    if (!this.map || !this.options.layer.stores.wmts) return;
    this.removeWmts();
    const wmts = this.options.layer.stores.wmts;
    this.map.addSource(this.rasterSourceId, {
      type: "raster",
      tiles: [buildWmtsTileUrl({
        baseUrl: wmts.base_url,
        layer: wmts.layer,
        tileMatrixSet: wmts.tileMatrixSet,
        format: wmts.format,
        style: wmts.style,
        time: this.time,
        depth: this.depth,
        verticalLabel: this.options.layer.dimensions.vertical?.label,
      })],
      tileSize: 256,
    });
    const rasterLayer = {
      id: this.rasterLayerId,
      type: "raster",
      source: this.rasterSourceId,
      metadata: this.metadata ? { ...this.metadata } : undefined,
      paint: { "raster-opacity": this.opacity },
    } as const;
    const before = this.getBeforeLayerId();
    if (before) {
      this.map.addLayer(rasterLayer, before);
      return;
    }
    this.map.addLayer(rasterLayer);
  }

  private removeWmts(): void {
    if (!this.map) return;
    if (this.map.getLayer(this.rasterLayerId)) this.map.removeLayer(this.rasterLayerId);
    if (this.map.getSource(this.rasterSourceId)) this.map.removeSource(this.rasterSourceId);
  }

  private emitLoaded(): void {
    this.emit("loaded", {
      min: 0,
      max: 0,
      unit: layerUnit(this.options.layer),
      time: toIsoTime(this.time),
      depth: this.depth,
    });
  }

  private emit<K extends keyof LayerEventMap>(
    event: K,
    ...args: Parameters<LayerEventMap[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const h of handlers) (h as Function)(...args);
    }
  }

  private getBeforeLayerId(): string | undefined {
    const before = this.options.before;
    if (!before || !this.map?.getLayer(before)) return undefined;
    return before;
  }
}
