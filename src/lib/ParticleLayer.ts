import type {
  Map as MaplibreMap,
  CustomLayerInterface,
  CustomRenderMethodInput,
} from "maplibre-gl";
import type { ParticleLayerOptions, ZoomWeighted, FieldMeta, VelocityData } from "./types.js";
import { saveGLState, restoreGLState } from "./gl-util.js";
import type { ColorRampInput } from "./gl-util.js";
import { ParticleSimulation } from "./ParticleSimulation.js";
import type { RenderMode } from "./ParticleSimulation.js";
import { VelocityField, stitchVelocityChunks } from "./VelocityField.js";
import { ZarrSource } from "./ZarrSource.js";

// ── Minimal event emitter ────────────────────────────────────────────

type LayerEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (err: Error) => void;
  /** Fired when a time step has been pre-fetched and is ready for instant swap. */
  frameBuffered: (ms: number) => void;
  /** Fired when the frame cache is wiped (viewport changed). */
  cacheInvalidated: () => void;
};

/**
 * Convert latitude to Mercator Y in [0,1] range.
 */
function latToMercY(lat: number): number {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
}

/**
 * Convert longitude to Mercator X in [0,1] range.
 */
function lngToMercX(lng: number): number {
  return (lng + 180) / 360;
}


export class ParticleLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MaplibreMap | null = null;
  private gl: WebGLRenderingContext | null = null;

  private simulation: ParticleSimulation;
  private velocityField: VelocityField;
  private zarrSource: ZarrSource;

  // Zoom-weighted params
  private speedFactorParam: ZoomWeighted;
  private fadeOpacityParam: ZoomWeighted;
  private zoomRange: [number, number];

  private variableU: string;
  private variableV: string;
  private time: string | number;
  private depth: number;
  private scalarMode: boolean;
  private scalarUnit: string;

  private initialized = false;
  private loading = false;
  // Unit 0: particles state, Unit 1: velocity, Unit 2: color ramp
  private velocityTexUnit = 1;
  private moveStartHandler: (() => void) | null = null;
  private moveEndHandler: (() => void) | null = null;

  /** Pre-fetched frames keyed by time-ms. Cleared when the viewport changes. */
  private frameCache = new Map<number, VelocityData>();
  /** Time-ms values currently being fetched in the background. */
  private inflight = new Set<number>();

  private listeners: Map<string, Set<Function>> = new Map();

  constructor(options: ParticleLayerOptions) {
    this.id = options.id;

    this.variableU = options.variableU ?? "uo";
    this.variableV = options.variableV ?? "vo";
    this.time = options.time ?? 0;
    this.depth = options.depth ?? 0;
    this.scalarMode = options.scalarMode ?? false;
    this.scalarUnit = options.scalarUnit ?? "m/s";

    this.speedFactorParam = options.speedFactor ?? 0.25;
    this.fadeOpacityParam = options.fadeOpacity ?? 0.996;
    this.zoomRange = options.zoomRange ?? [2, 12];

    this.zarrSource = new ZarrSource(options.source);
    this.velocityField = new VelocityField();
    this.simulation = new ParticleSimulation({
      particleDensity: options.particleDensity ?? 0.05,
      speedFactor: Array.isArray(options.speedFactor) ? options.speedFactor[0] : (options.speedFactor ?? 0.25),
      fadeOpacity: Array.isArray(options.fadeOpacity) ? options.fadeOpacity[0] : (options.fadeOpacity ?? 0.996),
      dropRate: options.dropRate ?? 0.003,
      dropRateBump: options.dropRateBump ?? 0.01,
      colorRamp: options.colorRamp,
      opacity: options.opacity ?? 1.0,
      logScale: options.logScale ?? false,
      vibrance: options.vibrance ?? 0.0,
    });
  }

  async onAdd(map: MaplibreMap, gl: WebGLRenderingContext): Promise<void> {
    this.map = map;
    this.gl = gl;

    this.simulation.init(gl);
    this.velocityField.init(gl);

    // Load Zarr metadata and initial velocity data
    this.initAsync();

    // Clear trail history on move start so screen-space ghost trails
    // don't persist when the viewport shifts.
    this.moveStartHandler = () => this.simulation.clearState();
    map.on("movestart", this.moveStartHandler);

    // Invalidate pre-fetched frame cache when the viewport changes,
    // as cached chunks were fetched for the previous lat bounds.
    this.moveEndHandler = () => {
      this.zarrSource.cancelAll();   // abort stale fetches before clearing tracking
      this.frameCache.clear();
      this.inflight.clear();
      this.emit("cacheInvalidated");
    };
    map.on("moveend", this.moveEndHandler);
  }

  private async initAsync(): Promise<void> {
    try {
      await this.zarrSource.init();
      await this.loadViewportVelocity();
      this.initialized = true;
      this.map?.triggerRepaint();
    } catch (err) {
      console.error("[zartigl] Failed to initialize:", err);
    }
  }

  // ── Core fetch / cache helpers ───────────────────────────────────────

  private timeToMs(time: string | number): number {
    return typeof time === "number" ? time : new Date(time).getTime();
  }

  private computeFieldMeta(data: VelocityData, time: string | number): FieldMeta {
    const timeStr = typeof time === "string" ? time : new Date(time).toISOString();
    if (this.scalarMode) {
      return { min: data.uMin, max: data.uMax, unit: this.scalarUnit, time: timeStr, depth: this.depth };
    }
    const maxSpeed = Math.sqrt(
      Math.max(data.uMin ** 2, data.uMax ** 2) +
      Math.max(data.vMin ** 2, data.vMax ** 2),
    );
    return { min: 0, max: maxSpeed, unit: "m/s", time: timeStr, depth: this.depth };
  }

  /**
   * Fetch and stitch velocity data for the given time without touching GL state.
   * The map's current viewport is used to determine the lat bounds of the request.
   */
  private async fetchVelocityData(time: string | number): Promise<VelocityData> {
    const bounds = this.map!.getBounds();
    const geoBounds = {
      west: -180,
      east: 180,
      south: Math.max(bounds.getSouth(), -85),
      north: Math.min(bounds.getNorth(), 85),
    };

    const timeIdx = this.zarrSource.findTimeIndex(time);
    const depthIdx = this.zarrSource.findDepthIndex(this.depth);

    console.log(
      `[zartigl] Loading velocity: depth=${this.depth} → depthIdx=${depthIdx}, ` +
      `actual depth value=${this.zarrSource.getCoords().vertical[depthIdx]}, ` +
      `timeIdx=${timeIdx}`
    );

    const uChunkInfos = this.zarrSource.getChunksForBounds(
      this.variableU,
      timeIdx,
      depthIdx,
      geoBounds,
    );

    const dims = this.zarrSource.getDimensions(this.variableU);
    const timeDim = dims.indexOf("time");
    const vertName = this.zarrSource.getVerticalDimName();
    const depthDim = dims.indexOf(vertName);
    const latDim = dims.indexOf("latitude");
    const lonDim = dims.indexOf("longitude");

    // Fetch U and V chunks in parallel
    const makeChunkFetch = (variable: string) =>
      uChunkInfos.map(async (info) => {
        const indices: number[] = [];
        indices[timeDim] = info.timeIdx;
        indices[depthDim] = info.depthIdx;
        indices[latDim] = info.latIdx;
        indices[lonDim] = info.lonIdx;
        const data = await this.zarrSource.fetchChunk(variable, indices);
        const chunkShape = this.zarrSource.getChunkShape(variable);
        const lonChunkSize = chunkShape[lonDim];
        return {
          data,
          latStart: info.latIdx * chunkShape[latDim],
          lonStart: info.lonIdx * lonChunkSize,
          latSize: info.latSize,
          lonSize: info.lonSize,
          lonChunkSize,
        };
      });

    const [uChunks, vChunks] = await Promise.all([
      Promise.all(makeChunkFetch(this.variableU)),
      this.scalarMode ? Promise.resolve([]) : Promise.all(makeChunkFetch(this.variableV)),
    ]);

    const latPixMin = Math.min(...uChunks.map(c => c.latStart));
    const latPixMax = Math.max(...uChunks.map(c => c.latStart + c.latSize));
    const lonPixMin = Math.min(...uChunks.map(c => c.lonStart));
    const lonPixMax = Math.max(...uChunks.map(c => c.lonStart + c.lonSize));
    const fetchedHeight = latPixMax - latPixMin;
    const fetchedWidth  = lonPixMax - lonPixMin;

    const uChunksRel = uChunks.map(c => ({
      ...c,
      latStart: c.latStart - latPixMin,
      lonStart: c.lonStart - lonPixMin,
    }));
    const vChunksRel = vChunks.map(c => ({
      ...c,
      latStart: c.latStart - latPixMin,
      lonStart: c.lonStart - lonPixMin,
    }));

    const coords = this.zarrSource.getCoords();
    const latLast = Math.min(latPixMax - 1, coords.latitude.length - 1);
    const lonLast = Math.min(lonPixMax - 1, coords.longitude.length - 1);
    const dataGeoBounds = {
      west:  coords.longitude[lonPixMin],
      east:  coords.longitude[lonLast],
      south: Math.min(coords.latitude[latPixMin], coords.latitude[latLast]),
      north: Math.max(coords.latitude[latPixMin], coords.latitude[latLast]),
    };
    const latDescending = coords.latitude[latPixMin] > coords.latitude[latLast];

    return stitchVelocityChunks(
      uChunksRel,
      vChunksRel,
      fetchedHeight,
      fetchedWidth,
      dataGeoBounds,
      latDescending,
      this.scalarMode,
    );
  }

  private async loadViewportVelocity(): Promise<void> {
    if (this.loading || !this.map) return;
    this.loading = true;
    this.emit("loading");

    try {
      const ms = this.timeToMs(this.time);
      let velocityData: VelocityData;

      if (this.frameCache.has(ms)) {
        velocityData = this.frameCache.get(ms)!;
      } else {
        velocityData = await this.fetchVelocityData(this.time);
        this.frameCache.set(ms, velocityData);
      }

      this.velocityField.update(velocityData);
      this.simulation.setScalarMode(velocityData.scalarMode ?? false);
      this.emit("loaded", this.computeFieldMeta(velocityData, this.time));
      this.map?.triggerRepaint();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[zartigl] Failed to load velocity:", err);
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.loading = false;
    }
  }

  render(
    gl: WebGLRenderingContext,
    options: CustomRenderMethodInput | number[],
  ): void {
    // maplibre-gl passes { modelViewProjectionMatrix, ... }; mapbox-gl passes the matrix directly
    const matrix = Array.isArray(options)
      ? options
      : (options as CustomRenderMethodInput).modelViewProjectionMatrix;
    if (!this.initialized || !this.velocityField.hasData() || !this.map) return;

    // Apply zoom-weighted params each frame
    this.applyZoomWeighting(this.map.getZoom());

    const saved = saveGLState(gl);

    try {
      const canvas = gl.canvas as HTMLCanvasElement;
      this.simulation.resize(canvas.width, canvas.height);
      // createFramebuffer (called inside resize) resets the FBO to null;
      // restore mapbox's active render target before simulation captures it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);

      // Bind velocity texture
      this.velocityField.bind(this.velocityTexUnit);

      // Viewport bounds — clamped to primary world for the update pass
      // (particle positions always live in [0,1] Mercator)
      const mapBounds = this.map.getBounds();
      const mercBounds = {
        minX: lngToMercX(Math.max(mapBounds.getWest(), -180)),
        minY: latToMercY(Math.min(mapBounds.getNorth(), 85)),
        maxX: lngToMercX(Math.min(mapBounds.getEast(), 180)),
        maxY: latToMercY(Math.max(mapBounds.getSouth(), -85)),
      };

      // Determine which world copies are visible (raw, unclamped bounds).
      // offset 0 = primary, +1 = right copy, -1 = left copy, etc.
      const rawMinX = (mapBounds.getWest() + 180) / 360;
      const rawMaxX = (mapBounds.getEast() + 180) / 360;
      const worldCopyOffsets: number[] = [];
      for (let n = Math.floor(rawMinX); n <= Math.floor(rawMaxX); n++) {
        worldCopyOffsets.push(n);
      }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);

      // mapbox-gl matrix maps [0, 1] Mercator → clip space.
      // maplibre-gl matrix maps [0, worldSize] Mercator → clip space.
      // The draw shader does: worldPos = (pos + offset) * worldSize, then matrix * worldPos.
      // For mapbox-gl we must pass worldSize = 1.0 so pos stays in [0, 1].
      const isMapboxConvention = Array.isArray(options);
      const worldSize = isMapboxConvention ? 1.0 : 512 * Math.pow(2, this.map.getZoom());
      this.simulation.render(
        this.velocityTexUnit,
        [this.velocityField.uMin, this.velocityField.vMin],
        [this.velocityField.uMax, this.velocityField.vMax],
        matrix,
        mercBounds,
        worldSize,
        worldCopyOffsets,
        this.velocityField.geoBounds,
      );
    } finally {
      restoreGLState(gl, saved);
    }

    this.map.triggerRepaint();
  }

  onRemove(): void {
    if (this.map) {
      if (this.moveStartHandler) this.map.off("movestart", this.moveStartHandler);
      if (this.moveEndHandler) this.map.off("moveend", this.moveEndHandler);
    }
    this.zarrSource.cancelAll();
    this.simulation.destroy();
    this.velocityField.destroy();
    this.frameCache.clear();
    this.inflight.clear();
    this.map = null;
    this.gl = null;
  }

  /**
   * Interpolate speed and fade per render frame (cheap uniform uploads).
   * t=0 at low zoom (global), t=1 at high zoom (local).
   * For each range [min, max]: min applies at high zoom, max at low zoom.
   */
  private applyZoomWeighting(zoom: number): void {
    const [zLow, zHigh] = this.zoomRange;
    const t = Math.max(0, Math.min(1, (zoom - zLow) / (zHigh - zLow)));

    if (Array.isArray(this.speedFactorParam)) {
      const [min, max] = this.speedFactorParam;
      this.simulation.setSpeedFactor(max + (min - max) * t);
    }

    if (Array.isArray(this.fadeOpacityParam)) {
      const [min, max] = this.fadeOpacityParam;
      this.simulation.setFadeOpacity(max + (min - max) * t);
    }
  }

// --- Public setters ---

  setTime(time: string | number): void {
    this.time = time;
    const ms = this.timeToMs(time);

    if (this.frameCache.has(ms)) {
      // Instant swap — no network round-trip needed.
      const data = this.frameCache.get(ms)!;
      this.velocityField.update(data);
      this.simulation.setScalarMode(data.scalarMode ?? false);
      this.emit("loaded", this.computeFieldMeta(data, time));
      this.map?.triggerRepaint();
    } else {
      this.loadViewportVelocity();
    }
  }

  /**
   * Pre-fetch velocity data for a future time step without swapping the active
   * field. Fires `frameBuffered(ms)` when ready so playback can advance
   * immediately without a loading gap.
   */
  async prefetchTime(ms: number): Promise<void> {
    if (!this.map || !this.initialized) return;
    if (this.frameCache.has(ms) || this.inflight.has(ms)) return;

    this.inflight.add(ms);
    try {
      const data = await this.fetchVelocityData(ms);
      // Guard against cache being cleared (e.g. viewport change) while we were fetching.
      if (!this.frameCache.has(ms)) {
        this.frameCache.set(ms, data);
        this.emit("frameBuffered", ms);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.warn("[zartigl] Prefetch failed for ms=" + ms, err);
      }
    } finally {
      this.inflight.delete(ms);
    }
  }

  /** True when the frame for the given time (ms) is already in the cache. */
  isFrameCached(ms: number): boolean {
    return this.frameCache.has(ms);
  }

  /** Abort all pending Zarr prefetch fetches and clear the inflight set. */
  cancelPrefetches(): void {
    this.zarrSource.cancelAll();
    this.inflight.clear();
  }

  setDepth(depth: number): void {
    this.depth = depth;
    this.frameCache.clear();
    this.inflight.clear();
    this.loadViewportVelocity();
  }

  setSpeedFactor(v: ZoomWeighted): void {
    this.speedFactorParam = v;
    if (!Array.isArray(v)) this.simulation.setSpeedFactor(v);
  }

  setFadeOpacity(v: ZoomWeighted): void {
    this.fadeOpacityParam = v;
    if (!Array.isArray(v)) this.simulation.setFadeOpacity(v);
  }

  setDropRate(v: number): void {
    this.simulation.setDropRate(v);
  }

  setDropRateBump(v: number): void {
    this.simulation.setDropRateBump(v);
  }

  setParticleDensity(density: number): void {
    this.simulation.setParticleDensity(density);
  }

  setZoomRange(range: [number, number]): void {
    this.zoomRange = range;
  }

  setColorRamp(ramp: ColorRampInput): void {
    // ParticleSimulation.setColorRamp delegates to createColorRampTexture which accepts ColorRampInput.
    // The cast is safe: ColorRampInput is a superset of Record<number, string> here.
    this.simulation.setColorRamp(ramp as unknown as Record<number, string>);
  }

  setRenderMode(mode: RenderMode): void {
    this.simulation.setRenderMode(mode);
    // Raster-only: nearest-neighbour shows the actual grid resolution.
    // Particles need linear interpolation for smooth velocity sampling mid-cell.
    this.velocityField.setFilter(mode !== "raster");
  }

  setOpacity(v: number): void {
    this.simulation.setOpacity(v);
  }

  setLogScale(v: boolean): void {
    this.simulation.setLogScale(v);
  }

  setVibrance(v: number): void {
    this.simulation.setVibrance(v);
  }

  setScalarVariable(varName: string): void {
    this.variableU = varName;
    this.frameCache.clear();
    this.inflight.clear();
    this.loadViewportVelocity();
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

  private emit<K extends keyof LayerEventMap>(
    event: K,
    ...args: Parameters<LayerEventMap[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const h of handlers) {
        (h as Function)(...args);
      }
    }
  }
}
