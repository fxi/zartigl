import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";
import type { ColorRampInput } from "./gl-util";
import { visibleWorldCopyOffsets } from "./geo-util";
import { restoreGLState, saveGLState } from "./gl-util";
import { ParticleSimulation } from "./ParticleSimulation";
import type { FieldMeta, ScalarLayerOptions, VelocityData } from "./types";
import { VelocityField, stitchVelocityChunks } from "./VelocityField";
import { ZarrSource } from "./ZarrSource";

type LayerEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (err: Error) => void;
  frameBuffered: (ms: number) => void;
  cacheInvalidated: () => void;
};

export class ScalarLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MaplibreMap | null = null;
  private gl: WebGLRenderingContext | null = null;
  private zarrSource: ZarrSource;
  private simulation: ParticleSimulation;
  private activeField: VelocityField;
  private activeData: VelocityData | null = null;
  private initialized = false;
  private loading = false;
  private reloadQueued = false;
  private generation = 0;
  private frameCache = new Map<number, VelocityData>();
  private inflight = new Set<number>();
  private listeners: Map<string, Set<Function>> = new Map();
  private variable: string;
  private time: string | number;
  private depth: number;
  private unit: string;
  private textureUnit = 1;

  constructor(options: ScalarLayerOptions) {
    this.id = options.id;
    this.variable = options.variable;
    this.time = options.time ?? 0;
    this.depth = options.depth ?? 0;
    this.unit = options.unit ?? "";
    this.zarrSource = options.zarrSource ?? new ZarrSource(options.source);
    this.activeField = new VelocityField();
    this.simulation = new ParticleSimulation({
      colorRamp: options.colorRamp,
      opacity: options.opacity ?? 1,
      logScale: options.logScale ?? false,
      vibrance: options.vibrance ?? 0,
      scalarMode: true,
      particleDensity: 0.001,
    });
    this.simulation.setRenderMode("raster");
  }

  async onAdd(map: MaplibreMap, gl: WebGLRenderingContext): Promise<void> {
    this.map = map;
    this.gl = gl;
    this.simulation.init(gl);
    this.simulation.setRenderMode("raster");
    this.simulation.setScalarMode(true);
    this.activeField.init(gl);
    this.activeField.setFilter(false);

    this.moveEndHandler = () => {
      this.zarrSource.cancelAll();
      this.frameCache.clear();
      this.inflight.clear();
      this.emit("cacheInvalidated");
      this.loadCurrent();
    };
    map.on("moveend", this.moveEndHandler);

    await this.initAsync();
  }

  private moveEndHandler: (() => void) | null = null;

  private async initAsync(): Promise<void> {
    try {
      await this.loadCurrent();
      this.map?.triggerRepaint();
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
    if (!this.map || !this.activeData || !this.activeField.hasData()) return;

    const saved = saveGLState(gl);
    try {
      const canvas = gl.canvas as HTMLCanvasElement;
      this.simulation.resize(canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);

      const bounds = this.map.getBounds();
      const isGlobe = this.map.getProjection?.()?.type === "globe";
      const worldSize = 512 * Math.pow(2, this.map.getZoom());

      this.activeField.bind(this.textureUnit);
      if (isGlobe) {
        this.simulation.renderGridGlobe(
          this.textureUnit,
          [this.activeData.uMin, this.activeData.vMin],
          [this.activeData.uMax, this.activeData.vMax],
          options.modelViewProjectionMatrix,
          this.activeField.geoBounds,
          options.defaultProjectionData.clippingPlane,
          1,
        );
      } else {
        this.simulation.renderGrid(
          this.textureUnit,
          [this.activeData.uMin, this.activeData.vMin],
          [this.activeData.uMax, this.activeData.vMax],
          options.modelViewProjectionMatrix,
          worldSize,
          visibleWorldCopyOffsets(bounds, false),
          this.activeField.geoBounds,
          1,
        );
      }
    } finally {
      restoreGLState(gl, saved);
    }
  }

  onRemove(): void {
    this.generation++;
    if (this.map && this.moveEndHandler) this.map.off("moveend", this.moveEndHandler);
    this.zarrSource.cancelAll();
    this.activeField.destroy();
    this.simulation.destroy();
    this.frameCache.clear();
    this.inflight.clear();
    this.map = null;
    this.gl = null;
  }

  setTime(time: string | number): void {
    this.time = time;
    const ms = this.timeToMs(time);
    const cached = this.frameCache.get(ms);
    if (cached) {
      this.setActive(cached, time);
      return;
    }
    this.loadCurrent();
  }

  setTimeAndDepth(time: string | number, depth: number): void {
    const depthChanged = this.depth !== depth;
    this.time = time;
    this.depth = depth;
    if (depthChanged) {
      this.generation++;
      this.frameCache.clear();
      this.inflight.clear();
    }
    this.setTime(time);
  }

  setDepth(depth: number): void {
    this.setTimeAndDepth(this.time, depth);
  }

  async prefetchTime(ms: number): Promise<void> {
    if (!this.map || !this.initialized) return;
    if (this.frameCache.has(ms) || this.inflight.has(ms)) return;
    this.inflight.add(ms);
    const generation = this.generation;
    try {
      const data = await this.fetchScalarData(ms);
      if (generation !== this.generation) return;
      this.frameCache.set(ms, data);
      this.emit("frameBuffered", ms);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.inflight.delete(ms);
    }
  }

  isFrameCached(ms: number): boolean {
    return this.frameCache.has(ms);
  }

  cancelPrefetches(): void {
    this.zarrSource.cancelAll();
    this.inflight.clear();
  }

  setColorRamp(ramp: ColorRampInput): void {
    this.simulation.setColorRamp(ramp as unknown as Record<number, string>);
    this.map?.triggerRepaint();
  }

  setOpacity(v: number): void {
    this.simulation.setOpacity(v);
    this.map?.triggerRepaint();
  }

  setLogScale(v: boolean): void {
    this.simulation.setLogScale(v);
    this.map?.triggerRepaint();
  }

  setVibrance(v: number): void {
    this.simulation.setVibrance(v);
    this.map?.triggerRepaint();
  }

  async samplePoint(options: {
    longitude: number;
    latitude: number;
    time?: string | number;
    depth?: number;
  }): Promise<{ longitude: number; latitude: number; value: number; unit: string; time: number; depth?: number }> {
    const data = this.activeData;
    if (!data) {
      return {
        longitude: options.longitude,
        latitude: options.latitude,
        value: NaN,
        unit: this.unit,
        time: this.timeToMs(this.time),
        depth: this.depth,
      };
    }

    return this.sampleActiveData(data, options.longitude, options.latitude);
  }

  on<K extends keyof LayerEventMap>(event: K, handler: LayerEventMap[K]): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof LayerEventMap>(event: K, handler: LayerEventMap[K]): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  private async loadCurrent(): Promise<void> {
    if (!this.map) return;
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    this.loading = true;
    this.emit("loading");
    const generation = this.generation;
    try {
      await this.zarrSource.init();
      if (generation !== this.generation) return;
      this.initialized = true;

      const ms = this.timeToMs(this.time);
      const data = this.frameCache.get(ms) ?? await this.fetchScalarData(this.time);
      if (generation !== this.generation) return;
      this.frameCache.set(ms, data);
      this.setActive(data, this.time);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.loading = false;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        this.loadCurrent();
      }
    }
  }

  private async fetchScalarData(time: string | number): Promise<VelocityData> {
    const bounds = this.map!.getBounds();
    const geoBounds = {
      west: -180,
      east: 180,
      south: Math.max(bounds.getSouth(), -85),
      north: Math.min(bounds.getNorth(), 85),
    };

    const timeIdx = this.zarrSource.findTimeIndex(time);
    const depthIdx = this.zarrSource.findDepthIndex(this.depth);
    const chunkInfos = this.zarrSource.getChunksForBounds(
      this.variable,
      timeIdx,
      depthIdx,
      geoBounds,
    );
    const dims = this.zarrSource.getDimensions(this.variable);
    const timeDim = dims.indexOf("time");
    const vertName = this.zarrSource.getVerticalDimName();
    const depthDim = dims.indexOf(vertName);
    const latDim = dims.indexOf("latitude");
    const lonDim = dims.indexOf("longitude");
    const chunkShape = this.zarrSource.getChunkShape(this.variable);

    const chunks = await Promise.all(chunkInfos.map(async (info) => {
      const indices: number[] = [];
      indices[timeDim] = info.timeIdx;
      indices[depthDim] = info.depthIdx;
      indices[latDim] = info.latIdx;
      indices[lonDim] = info.lonIdx;
      const data = await this.zarrSource.fetchChunk(this.variable, indices);
      return {
        data,
        latStart: info.latIdx * chunkShape[latDim],
        lonStart: info.lonIdx * chunkShape[lonDim],
        latSize: info.latSize,
        lonSize: info.lonSize,
        lonChunkSize: chunkShape[lonDim],
      };
    }));

    const latPixMin = Math.min(...chunks.map(c => c.latStart));
    const latPixMax = Math.max(...chunks.map(c => c.latStart + c.latSize));
    const lonPixMin = Math.min(...chunks.map(c => c.lonStart));
    const lonPixMax = Math.max(...chunks.map(c => c.lonStart + c.lonSize));
    const fetchedHeight = latPixMax - latPixMin;
    const fetchedWidth = lonPixMax - lonPixMin;
    const chunksRel = chunks.map(c => ({
      ...c,
      latStart: c.latStart - latPixMin,
      lonStart: c.lonStart - lonPixMin,
    }));

    const coords = this.zarrSource.getCoords();
    const latLast = Math.min(latPixMax - 1, coords.latitude.length - 1);
    const lonLast = Math.min(lonPixMax - 1, coords.longitude.length - 1);
    const dataGeoBounds = {
      west: coords.longitude[lonPixMin],
      east: coords.longitude[lonLast],
      south: Math.min(coords.latitude[latPixMin], coords.latitude[latLast]),
      north: Math.max(coords.latitude[latPixMin], coords.latitude[latLast]),
    };
    const latDescending = coords.latitude[latPixMin] > coords.latitude[latLast];
    return stitchVelocityChunks(
      chunksRel,
      [],
      fetchedHeight,
      fetchedWidth,
      dataGeoBounds,
      latDescending,
      true,
    );
  }

  private setActive(data: VelocityData, time: string | number): void {
    this.activeData = data;
    this.activeField.update(data);
    this.activeField.setFilter(false);
    this.emit("loaded", this.computeFieldMeta(data, time));
    this.map?.triggerRepaint();
  }

  private sampleActiveData(
    data: VelocityData,
    longitude: number,
    latitude: number,
  ): { longitude: number; latitude: number; value: number; unit: string; time: number; depth?: number } {
    const { west, east, south, north } = data.bounds;
    const lonSpan = east - west;
    const latSpan = north - south;
    if (data.width <= 0 || data.height <= 0 || lonSpan <= 0 || latSpan <= 0) {
      return {
        longitude,
        latitude,
        value: NaN,
        unit: this.unit,
        time: this.timeToMs(this.time),
        depth: this.depth,
      };
    }

    const sampleLongitude = west >= 0 && east > 180
      ? ((longitude % 360) + 360) % 360
      : ((((longitude + 180) % 360) + 360) % 360) - 180;

    if (
      sampleLongitude < west ||
      sampleLongitude > east ||
      latitude < south ||
      latitude > north
    ) {
      return {
        longitude,
        latitude,
        value: NaN,
        unit: this.unit,
        time: this.timeToMs(this.time),
        depth: this.depth,
      };
    }

    const x = (sampleLongitude - west) / lonSpan;
    const y = data.latDescending
      ? (north - latitude) / latSpan
      : (latitude - south) / latSpan;
    const col = Math.max(0, Math.min(data.width - 1, Math.round(x * (data.width - 1))));
    const row = Math.max(0, Math.min(data.height - 1, Math.round(y * (data.height - 1))));
    const value = data.u[row * data.width + col] ?? NaN;
    const gridLongitude = west + (col / Math.max(1, data.width - 1)) * lonSpan;
    const gridLatitude = data.latDescending
      ? north - (row / Math.max(1, data.height - 1)) * latSpan
      : south + (row / Math.max(1, data.height - 1)) * latSpan;

    return {
      longitude: gridLongitude,
      latitude: gridLatitude,
      value,
      unit: this.unit,
      time: this.timeToMs(this.time),
      depth: this.depth,
    };
  }

  private computeFieldMeta(data: VelocityData, time: string | number): FieldMeta {
    const timeStr = typeof time === "string" ? time : new Date(time).toISOString();
    return { min: data.uMin, max: data.uMax, unit: this.unit, time: timeStr, depth: this.depth };
  }

  private timeToMs(time: string | number): number {
    return typeof time === "number" ? time : new Date(time).getTime();
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
}
