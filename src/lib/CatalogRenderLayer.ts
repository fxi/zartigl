import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";
import { ScalarLayer } from "./ScalarLayer";
import type { ScalarLayerDebugInfo } from "./ScalarLayer";
import { VectorLayer } from "./VectorLayer";
import type { VectorLayerDebugInfo } from "./VectorLayer";
import type {
  CatalogRenderLayerBackend,
  CatalogRenderLayerOptions,
  FieldMeta,
} from "./types";
import type { ColorRampInput } from "./gl-util";
import type { CatalogEntry, CatalogWmtsSource, CatalogZarrSource } from "../catalog/types";
import type { RenderMode } from "./ParticleSimulation";
import type { ZartiglStatus } from "./load-status";
import { GeoVideoLayer } from "./GeoVideoLayer";
import type { GeoVideoLayerDebugInfo } from "./GeoVideoLayer";

type LayerEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (err: Error) => void;
  status: (status: ZartiglStatus) => void;
  frameBuffered: (ms: number) => void;
  cacheInvalidated: () => void;
  timeChange: (time: number) => void;
  playbackChange: (playing: boolean) => void;
};

export type CatalogRenderLayerDebugInfo = {
  id: string;
  backend: CatalogRenderLayerBackend;
  catalogLayer: {
    id: string;
    title: string;
    kind: CatalogEntry["kind"];
  };
  time: string | number;
  depth: number;
  opacity: number;
  delegate: VectorLayerDebugInfo | ScalarLayerDebugInfo | GeoVideoLayerDebugInfo | null;
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

export function resolveWmtsTileTemplate(options: {
  template: string;
  tileMatrixSet?: string;
  style?: string;
  time?: string | number;
  depth?: number;
  verticalLabel?: string;
}): string | undefined {
  let result = options.template
    .replace(/\{TileMatrix\}/gi, "{z}")
    .replace(/\{TileRow\}/gi, "{y}")
    .replace(/\{TileCol\}/gi, "{x}");
  if (options.tileMatrixSet != null) result = result.replace(/\{TileMatrixSet\}/gi, encodeParam(options.tileMatrixSet));
  if (options.style != null) result = result.replace(/\{Style\}/gi, encodeParam(options.style));
  if (options.time != null) {
    result = result.replace(/\{time\}/gi, encodeParam(toIsoTime(options.time)));
  }
  if (options.depth != null) {
    result = result.replace(
      /\{elevation\}/gi,
      encodeParam(wmtsElevation(options.depth, options.verticalLabel)),
    );
  }
  return [...result.matchAll(/\{([^{}]+)\}/g)].some((match) => !/^(?:z|y|x)$/i.test(match[1]))
    ? undefined
    : result;
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

export function selectCatalogRenderLayerBackend(options: CatalogRenderLayerOptions): CatalogRenderLayerBackend {
  if (options.sourceConfig.type === "wmts") return "scalar-wmts";
  if (options.sourceConfig.type === "geovideo") return "scalar-geovideo";
  return options.entry.kind === "vector" ? "vector-zarr" : "scalar-zarr";
}

function scalarLayerVariable(source: CatalogZarrSource): string {
  return source.variables.kind === "scalar" ? source.variables.value : "scalar";
}

function vectorLayerU(source: CatalogZarrSource): string {
  return source.variables.kind === "vector" ? (source.variables.u ?? "uo") : "uo";
}

function vectorLayerV(source: CatalogZarrSource): string {
  return source.variables.kind === "vector" ? (source.variables.v ?? "vo") : "vo";
}

function vectorLayerDerivation(source: CatalogZarrSource) {
  return source.variables.kind === "vector" ? source.variables.derivation : undefined;
}

export class CatalogRenderLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  readonly metadata?: Record<string, unknown>;

  private readonly options: CatalogRenderLayerOptions;
  private readonly backend: CatalogRenderLayerBackend;
  private delegate: ScalarLayer | VectorLayer | GeoVideoLayer | null = null;
  private map: MaplibreMap | null = null;
  private rasterSourceId: string;
  private rasterLayerId: string;
  private time: string | number;
  private depth: number;
  private opacity: number;
  private suspended = false;
  private listeners: Map<string, Set<Function>> = new Map();

  constructor(options: CatalogRenderLayerOptions) {
    this.options = options;
    this.id = options.id;
    this.metadata = options.metadata ? { ...options.metadata } : undefined;
    this.backend = selectCatalogRenderLayerBackend(options);
    this.rasterSourceId = `${options.id}-wmts-source`;
    this.rasterLayerId = `${options.id}-wmts`;
    this.time = options.time ?? 0;
    this.depth = options.depth ?? 0;
    this.opacity = options.opacity ?? 1;

    if (this.backend === "vector-zarr") {
      const sourceConfig = options.sourceConfig as CatalogZarrSource;
      this.delegate = new VectorLayer({
        ...options,
        source: sourceConfig.endpoints.field,
        zarrSource: options.zarrSource,
        variableU: vectorLayerU(sourceConfig),
        variableV: vectorLayerV(sourceConfig),
        vectorDerivation: vectorLayerDerivation(sourceConfig),
        unit: options.unit ?? "",
      });
    } else if (this.backend === "scalar-zarr") {
      const sourceConfig = options.sourceConfig as CatalogZarrSource;
      this.delegate = new ScalarLayer({
        id: options.id,
        source: sourceConfig.endpoints.field,
        zarrSource: options.zarrSource,
        variable: scalarLayerVariable(sourceConfig),
        time: options.time,
        depth: options.depth,
        colorRamp: options.colorRamp,
        opacity: options.opacity,
        logScale: options.logScale,
        vibrance: options.vibrance,
        colorDomain: options.colorDomain,
        particleState: options.particleState,
        rgba8MaxParticleZoom: options.rgba8MaxParticleZoom,
        unit: options.unit ?? "",
      });
    } else if (this.backend === "scalar-geovideo") {
      if (options.sourceConfig.type !== "geovideo") throw new Error("Invalid GeoVideo source");
      this.delegate = new GeoVideoLayer({
        id: options.id,
        manifest: options.geoVideoManifest ?? options.sourceConfig.manifestUrl,
        autoplay: options.geoVideoAutoplay,
        loop: options.geoVideoLoop,
        playbackRate: options.geoVideoPlaybackRate,
        time: options.time,
        timeRange: options.geoVideoTimeRange,
        opacity: options.opacity,
        colorRamp: options.colorRamp,
        colorDomain: options.colorDomain,
        logScale: options.logScale,
        vibrance: options.vibrance,
      });
    }
  }

  getBackend(): CatalogRenderLayerBackend {
    return this.backend;
  }

  getDebugInfo(): CatalogRenderLayerDebugInfo {
    return {
      id: this.id,
      backend: this.backend,
      catalogLayer: {
        id: this.options.entry.id,
        title: this.options.entry.title.en ?? Object.values(this.options.entry.title)[0] ?? "",
        kind: this.options.entry.kind,
      },
      time: this.time,
      depth: this.depth,
      opacity: this.opacity,
      delegate: this.delegate?.getDebugInfo() ?? null,
    };
  }

  onAdd(map: MaplibreMap, gl: WebGLRenderingContext): void | Promise<void> {
    this.map = map;
    if (this.delegate) return this.delegate.onAdd(map, gl);
    this.addOrUpdateWmts();
    this.emitLoaded();
  }

  render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
    if (!this.suspended) this.delegate?.render(gl, options);
  }

  onRemove(): void {
    this.delegate?.onRemove();
    this.removeWmts();
    this.map = null;
  }

  setTime(time: string | number): void {
    this.time = time;
    if (this.suspended) return;
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
    if (this.suspended) return;
    if (this.delegate) {
      this.delegate.setTimeAndDepth(time, depth);
      return;
    }
    this.addOrUpdateWmts();
    this.emitLoaded();
  }

  setDepth(depth: number): void {
    this.depth = depth;
    if (this.suspended) return;
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

  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (this.delegate) {
      this.delegate.suspend();
      return;
    }
    this.removeWmts();
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.delegate) {
      this.delegate.setTimeAndDepth(this.time, this.depth);
      this.delegate.resume();
      return;
    }
    this.addOrUpdateWmts();
    this.emitLoaded();
  }

  setSpeed(v: number): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setSpeed(v);
  }

  setFade(v: number): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setFade(v);
  }

  setParticleDensity(density: number): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setParticleDensity(density);
  }

  setRenderMode(mode: RenderMode): void {
    if (this.delegate instanceof VectorLayer) this.delegate.setRenderMode(mode);
  }

  setRgba8MaxParticleZoom(v: number): void {
    this.delegate?.setRgba8MaxParticleZoom(v);
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
    if (this.delegate instanceof GeoVideoLayer) this.delegate.setLogScale(v);
  }

  setVibrance(v: number): void {
    this.delegate?.setVibrance(v);
  }

  setColorDomain(domain: [number, number] | null): void {
    if (this.delegate instanceof ScalarLayer) this.delegate.setColorDomain(domain);
    if (this.delegate instanceof GeoVideoLayer) this.delegate.setColorDomain(domain);
  }

  async play(): Promise<void> {
    if (this.delegate instanceof GeoVideoLayer) await this.delegate.play();
  }

  pause(): void {
    if (this.delegate instanceof GeoVideoLayer) this.delegate.pause();
  }

  setLoop(loop: boolean): void {
    if (this.delegate instanceof GeoVideoLayer) this.delegate.setLoop(loop);
  }

  setPlaybackRate(rate: number): void {
    if (this.delegate instanceof GeoVideoLayer) this.delegate.setPlaybackRate(rate);
  }

  setTimeRange(range: [number, number]): void {
    if (this.delegate instanceof GeoVideoLayer) this.delegate.setTimeRange(range);
  }

  async samplePoint(options: { longitude: number; latitude: number; time?: string | number; depth?: number }) {
    if (this.delegate instanceof ScalarLayer) return this.delegate.samplePoint(options);
    return undefined;
  }

  on<K extends keyof LayerEventMap>(event: K, handler: LayerEventMap[K]): this {
    const delegate = this.delegate as unknown as {
      on?: (name: string, callback: Function) => unknown;
    } | null;
    delegate?.on?.(event, handler);
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof LayerEventMap>(event: K, handler: LayerEventMap[K]): this {
    const delegate = this.delegate as unknown as {
      off?: (name: string, callback: Function) => unknown;
    } | null;
    delegate?.off?.(event, handler);
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  private addOrUpdateWmts(): void {
    if (!this.map || this.options.sourceConfig.type !== "wmts") return;
    this.removeWmts();
    const wmts = this.options.sourceConfig as CatalogWmtsSource;
    const tiles = wmts.tileUrlTemplate
      ? [resolveWmtsTileTemplate({
          template: wmts.tileUrlTemplate,
          tileMatrixSet: wmts.tileMatrixSet,
          style: wmts.style,
          time: this.time,
          depth: this.depth,
          verticalLabel: this.options.verticalLabel,
        }) ?? buildWmtsTileUrl({
          baseUrl: wmts.baseUrl ?? new URL(wmts.capabilitiesUrl).origin,
          layer: wmts.layer,
          tileMatrixSet: wmts.tileMatrixSet ?? "EPSG:3857",
          format: wmts.format ?? "image/png",
          style: wmts.style,
          time: this.time,
          depth: this.depth,
          verticalLabel: this.options.verticalLabel,
        })]
      : [buildWmtsTileUrl({
          baseUrl: wmts.baseUrl ?? new URL(wmts.capabilitiesUrl).origin,
          layer: wmts.layer,
          tileMatrixSet: wmts.tileMatrixSet ?? "EPSG:3857",
          format: wmts.format ?? "image/png",
          style: wmts.style,
          time: this.time,
          depth: this.depth,
          verticalLabel: this.options.verticalLabel,
        })];
    this.map.addSource(this.rasterSourceId, {
      type: "raster",
      tiles,
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
    const time = typeof this.time === "number" ? this.time : new Date(this.time).getTime();
    this.emit("status", { phase: "rendering", time });
    this.emit("loaded", {
      min: 0,
      max: 0,
      unit: this.options.unit ?? "",
      time: toIsoTime(this.time),
      depth: this.depth,
    });
    this.emit("status", { phase: "ready", time });
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
