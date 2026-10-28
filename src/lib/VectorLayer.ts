import {
  GeoVideoPlayback,
  type GeoVideoPlaybackEvents,
  type GeoVideoPlaybackReplaceOptions,
} from "./GeoVideoPlayback";
import type { GeoVideoManifest } from "./geovideo";
import type { VelocityTexturePair } from "./velocity-pair";
import type {
  Map as MaplibreMap,
  CustomLayerInterface,
  CustomRenderMethodInput,
} from "maplibre-gl";
import type {
  VectorLayerOptions,
  VectorFieldSource,
  FieldMeta,
  VelocityData,
} from "./types";
import { requireWebGL2, saveGLState, restoreGLState } from "./gl-util";
import { resolveBackdrop } from "./backdrop";
import type { BackdropStyle } from "../catalog/style";
import type { ColorRampInput } from "./gl-util";
import {
  coversViewportLatitude,
  globeCenterVector,
  paddedViewportGeoBounds,
  particleUpdateBounds,
  visibleWorldCopyOffsets,
  viewportGeoBounds,
} from "./geo-util";
import { ParticleSimulation } from "./ParticleSimulation";
import { resolveColorGrade, type ColorGrade } from "./color-grade";
import type {
  ParticleSimulationDebugInfo,
  RenderMode,
} from "./ParticleSimulation";
import { VelocityField, stitchVelocityChunks } from "./VelocityField";
import { ZarrSource } from "./ZarrSource";
import { deriveDirectionMagnitudeComponents } from "./vector-derivation";
import {
  blockedStatus,
  hasRenderableVector,
  ZartiglFrameUnavailableError,
  type ZartiglStatus,
} from "./load-status";
import { fadeToOpacity } from "./trail-fade";

// ── Minimal event emitter ────────────────────────────────────────────

type LayerEventMap = GeoVideoPlaybackEvents & {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (err: Error) => void;
  status: (status: ZartiglStatus) => void;
  /** Fired when a time step has been pre-fetched and is ready for instant swap. */
  frameBuffered: (ms: number) => void;
  /** Fired when the frame cache is wiped (viewport changed). */
  cacheInvalidated: () => void;
};

export interface VectorLayerDebugInfo {
  kind: "vector";
  id: string;
  initialized: boolean;
  loading: boolean;
  variableU: string;
  variableV: string;
  time: string | number;
  depth: number;
  unit: string;
  simulation: ParticleSimulationDebugInfo;
}

/** Public 0–1 trail length; see trail-fade.ts. */
const DEFAULT_FADE = 0.7;

export class VectorLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;

  private readonly playback: GeoVideoPlayback | null;
  private readonly geoVideoManifest?: GeoVideoManifest;
  private simulation: ParticleSimulation;
  private velocityField: VelocityField;
  private readonly zarrSourceValue: VectorFieldSource | null;
  private get zarrSource(): VectorFieldSource {
    if (!this.zarrSourceValue) {
      throw new Error("GeoVideo fields are owned by the playback controller");
    }
    return this.zarrSourceValue;
  }

  private variableU: string;
  private variableV: string;
  private vectorDerivation: VectorLayerOptions["vectorDerivation"];
  private unit: string;
  private time: string | number;
  private depth: number;
  private initialized = false;
  private suspended = false;
  private loading = false;
  private reloadQueued = false;
  private reloadQueuedResetParticles = false;
  private generation = 0;
  private requestId = 0;
  private pendingReadyTime: number | null = null;
  // Unit 0: particles state, Unit 1: velocity, Unit 2: color ramp
  private velocityTexUnit = 1;
  private moveStartHandler: (() => void) | null = null;
  private moveHandler: (() => void) | null = null;
  private moveEndHandler: (() => void) | null = null;

  /** Pre-fetched frames keyed by time-ms. Cleared when the viewport changes. */
  private frameCache = new Map<number, VelocityData>();
  /** Time-ms values currently being fetched in the background. */
  private inflight = new Set<number>();

  private listeners: Map<string, Set<Function>> = new Map();

  constructor(options: VectorLayerOptions) {
    this.id = options.id;
    this.geoVideoManifest = options.geoVideo?.manifest;
    if (
      this.geoVideoManifest &&
      this.geoVideoManifest.encoding.kind !== "vector-luma"
    ) {
      throw new Error("Vector GeoVideo requires a vector-luma manifest");
    }
    this.playback = options.geoVideo
      ? new GeoVideoPlayback(
          { ...options.geoVideo, time: options.time },
          () => this.map?.triggerRepaint(),
          (event, ...args) => {
            if (event === "loaded") {
              this.initialized = true;
              const meta = args[0] as FieldMeta;
              const encoding = this.playback?.field?.manifest.encoding;
              this.emit("loaded", {
                ...meta,
                min: 0,
                max:
                  encoding?.kind === "vector-luma"
                    ? Math.SQRT2 * encoding.valueDomain
                    : meta.max,
                unit: this.unit,
                depth: this.depth,
              });
              return;
            }
            if (event === "timeChange") {
              this.time = args[0] as number;
            }
            this.emit(event, ...args);
          },
        )
      : null;

    this.variableU = options.variableU ?? "uo";
    this.variableV = options.variableV ?? "vo";
    this.vectorDerivation = options.vectorDerivation;
    this.unit = options.unit ?? "m/s";
    this.time = options.time ?? 0;
    this.depth = options.depth ?? 0;
    this.zarrSourceValue = this.playback
      ? null
      : (options.zarrSource ?? new ZarrSource(options.source));
    this.velocityField = new VelocityField();
    this.simulation = new ParticleSimulation({
      particleDensity: options.particleDensity ?? 0.05,
      speed: options.speed ?? 1.0,
      fadeOpacity: fadeToOpacity(options.fade ?? DEFAULT_FADE),
      colorRamp: options.colorRamp,
      opacity: options.opacity ?? 1.0,
      logScale: options.logScale ?? false,
      vibrance: options.vibrance ?? 0.0,
      colorGrade: resolveColorGrade(options.colorGrade),
      backdrop: resolveBackdrop(options.backdrop),
      particleState: options.particleState ?? "auto",
      rgba8MaxParticleZoom: options.rgba8MaxParticleZoom ?? 4,
    });
    this.setRenderMode(options.renderMode ?? "particles");
  }

  async onAdd(
    map: MaplibreMap,
    context: WebGLRenderingContext | WebGL2RenderingContext,
  ): Promise<void> {
    const gl = requireWebGL2(context);
    this.map = map;
    this.gl = gl;

    this.simulation.init(gl);
    this.velocityField.init(gl);

    // Load Zarr metadata and initial velocity data
    if (this.playback && this.geoVideoManifest) {
      this.emit("loading");
      this.emit("status", { phase: "metadata" });
      void this.playback
        .load(gl, this.geoVideoManifest)
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          if (err.name !== "AbortError" && this.map) {
            this.playback?.pause();
            this.emit("status", { phase: "error", error: err });
            this.emit("error", err);
          }
        });
    } else {
      this.initAsync();
    }

    // Trail history is screen-space. During camera motion, decay it rapidly
    // instead of clearing every frame, preserving short visual continuity.
    this.moveStartHandler = () => {
      if (this.suspended) {
        return;
      }
      this.simulation.setCameraMoving(true);
      this.map?.triggerRepaint();
    };
    map.on("movestart", this.moveStartHandler);

    this.moveHandler = () => {
      if (!this.suspended) {
        this.map?.triggerRepaint();
      }
    };
    map.on("move", this.moveHandler);

    this.moveEndHandler = () => {
      this.simulation.setCameraMoving(false);
      this.reloadIfViewportUncovered();
      if (!this.suspended) {
        this.map?.triggerRepaint();
      }
    };
    map.on("moveend", this.moveEndHandler);
  }

  private async initAsync(): Promise<void> {
    try {
      await this.loadViewportVelocity();
      this.reloadIfViewportUncovered();
      this.map?.triggerRepaint();
    } catch (err) {
      console.error("[zartigl] Failed to initialize:", err);
    }
  }

  // ── Core fetch / cache helpers ───────────────────────────────────────

  private timeToMs(time: string | number): number {
    return typeof time === "number" ? time : new Date(time).getTime();
  }

  private computeFieldMeta(
    data: VelocityData,
    time: string | number,
  ): FieldMeta {
    const timeStr =
      typeof time === "string" ? time : new Date(time).toISOString();
    const maxSpeed = Math.sqrt(
      Math.max(data.uMin ** 2, data.uMax ** 2) +
        Math.max(data.vMin ** 2, data.vMax ** 2),
    );
    return {
      min: 0,
      max: maxSpeed,
      unit: this.unit,
      time: timeStr,
      depth: this.depth,
    };
  }

  private isViewportCovered(): boolean {
    if (!this.map || !this.velocityField.hasData()) {
      return false;
    }
    return coversViewportLatitude(
      this.velocityField.geoBounds,
      viewportGeoBounds(this.map.getBounds()),
    );
  }

  private reloadIfViewportUncovered(): void {
    if (this.playback) {
      return;
    }
    if (!this.map || !this.initialized) {
      return;
    }
    if (this.isViewportCovered()) {
      return;
    }

    this.generation++;
    this.requestId++;
    this.pendingReadyTime = null;
    this.zarrSource.cancelAll();
    this.frameCache.clear();
    this.inflight.clear();
    this.emit("cacheInvalidated");
    if (this.suspended) {
      this.reloadQueued = true;
      this.reloadQueuedResetParticles = true;
      return;
    }
    this.loadViewportVelocity({ resetParticles: true });
  }

  /**
   * Fetch and stitch velocity data for the given time without touching GL state.
   * The map's current viewport is used to determine the lat bounds of the request.
   */
  private async fetchVelocityData(
    time: string | number,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<VelocityData> {
    const bounds = this.map!.getBounds();
    const isGlobe = this.map!.getProjection?.()?.type === "globe";
    const geoBounds = paddedViewportGeoBounds(bounds, 1, isGlobe);

    const timeIdx = this.zarrSource.findTimeIndex(time);
    const depthIdx = this.zarrSource.findDepthIndex(this.depth);

    console.log(
      `[zartigl] Loading velocity: depth=${this.depth} → depthIdx=${depthIdx}, ` +
        `actual depth value=${
          this.zarrSource.getCoords().vertical[depthIdx]
        }, ` +
        `timeIdx=${timeIdx}`,
    );

    const baseVariable =
      this.vectorDerivation?.direction_variable ?? this.variableU;
    const uChunkInfos = this.zarrSource.getChunksForBounds(
      baseVariable,
      timeIdx,
      depthIdx,
      geoBounds,
    );

    const dims = this.zarrSource.getDimensions(baseVariable);
    const latDim = dims.indexOf("latitude");
    const lonDim = dims.indexOf("longitude");

    let completed = 0;
    const total = uChunkInfos.length * 2;
    const missingStatuses: number[] = [];
    const missingUrls: string[] = [];
    onProgress?.(completed, total);

    // Fetch U and V chunks in parallel
    const makeChunkFetch = (variable: string) =>
      uChunkInfos.map(async (info) => {
        const result = await this.zarrSource.fetchSpatialChunkResult(variable, {
          timeIndex: info.timeIdx,
          verticalIndex: info.depthIdx,
          latitudeChunkIndex: info.latIdx,
          longitudeChunkIndex: info.lonIdx,
        });
        if (result.missing) {
          if (result.status != null) {
            missingStatuses.push(result.status);
          }
          missingUrls.push(result.url);
        }
        completed++;
        onProgress?.(completed, total);
        const chunkShape = this.zarrSource.getChunkShape(variable);
        const lonChunkSize = chunkShape[lonDim];
        return {
          data: result.data,
          latStart: info.latIdx * chunkShape[latDim],
          lonStart: info.lonIdx * lonChunkSize,
          latSize: info.latSize,
          lonSize: info.lonSize,
          lonChunkSize,
        };
      });

    const [uChunks, vChunks] = this.vectorDerivation
      ? deriveVectorChunks(
          await Promise.all(
            makeChunkFetch(this.vectorDerivation.direction_variable),
          ),
          await Promise.all(
            makeChunkFetch(this.vectorDerivation.magnitude_variable),
          ),
          this.vectorDerivation,
        )
      : await Promise.all([
          Promise.all(makeChunkFetch(this.variableU)),
          Promise.all(makeChunkFetch(this.variableV)),
        ]);

    const latPixMin = Math.min(...uChunks.map((c) => c.latStart));
    const latPixMax = Math.max(...uChunks.map((c) => c.latStart + c.latSize));
    const lonPixMin = Math.min(...uChunks.map((c) => c.lonStart));
    const lonPixMax = Math.max(...uChunks.map((c) => c.lonStart + c.lonSize));
    const fetchedHeight = latPixMax - latPixMin;
    const fetchedWidth = lonPixMax - lonPixMin;

    const uChunksRel = uChunks.map((c) => ({
      ...c,
      latStart: c.latStart - latPixMin,
      lonStart: c.lonStart - lonPixMin,
    }));
    const vChunksRel = vChunks.map((c) => ({
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

    const stitched = stitchVelocityChunks(
      uChunksRel,
      vChunksRel,
      fetchedHeight,
      fetchedWidth,
      dataGeoBounds,
      latDescending,
    );
    const domain = this.zarrSource.getValueDomain?.();
    if (domain != null && domain > 0) {
      stitched.uMin = -domain;
      stitched.uMax = domain;
      stitched.vMin = -domain;
      stitched.vMax = domain;
    }
    if (!hasRenderableVector(stitched.u, stitched.v)) {
      throw new ZartiglFrameUnavailableError(
        this.timeToMs(time),
        missingStatuses,
        missingUrls,
      );
    }
    return stitched;
  }

  private async loadViewportVelocity(
    options: { resetParticles?: boolean } = {},
  ): Promise<void> {
    if (this.suspended || !this.map) {
      return;
    }
    if (this.loading) {
      this.reloadQueued = true;
      this.reloadQueuedResetParticles ||= options.resetParticles ?? false;
      return;
    }
    this.loading = true;
    this.emit("loading");
    const generation = this.generation;
    const requestId = this.requestId;
    const requestedTime = this.time;
    const requestedMs = this.timeToMs(requestedTime);

    try {
      await this.zarrSource.init();
      if (generation !== this.generation || requestId !== this.requestId) {
        return;
      }
      this.initialized = true;

      let velocityData: VelocityData;

      if (this.frameCache.has(requestedMs)) {
        velocityData = this.frameCache.get(requestedMs)!;
      } else {
        const fetched = await this.fetchVelocityData(
          requestedTime,
          (completed, total) => {
            if (
              generation === this.generation &&
              requestId === this.requestId
            ) {
              this.emit("status", {
                phase: "fetching",
                time: requestedMs,
                completed,
                total,
              });
            }
          },
        );
        if (generation !== this.generation || requestId !== this.requestId) {
          return;
        }
        this.frameCache.set(requestedMs, fetched);
        velocityData = fetched;
      }

      if (generation !== this.generation || requestId !== this.requestId) {
        return;
      }
      this.emit("status", { phase: "rendering", time: requestedMs });
      this.velocityField.update(velocityData);
      if (options.resetParticles) {
        this.simulation.resetParticles();
      }
      this.emit("loaded", this.computeFieldMeta(velocityData, requestedTime));
      this.pendingReadyTime = requestedMs;
      this.map?.triggerRepaint();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("[zartigl] Failed to load velocity:", error);
        if (generation === this.generation && requestId === this.requestId) {
          this.emit(
            "status",
            error instanceof ZartiglFrameUnavailableError
              ? blockedStatus(error)
              : { phase: "error", time: requestedMs, error },
          );
          this.emit("error", error);
        }
      }
    } finally {
      this.loading = false;
      if (this.reloadQueued && !this.suspended) {
        const resetParticles = this.reloadQueuedResetParticles;
        this.reloadQueued = false;
        this.reloadQueuedResetParticles = false;
        this.loadViewportVelocity({ resetParticles });
      }
    }
  }

  render(
    context: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    const gl = requireWebGL2(context);
    const matrix = options.modelViewProjectionMatrix;
    if (this.suspended || !this.map) {
      return;
    }
    const textures = this.playback?.sample(performance.now());
    const field = this.playback?.field;
    if (
      this.playback
        ? !textures || !field
        : !this.initialized || !this.velocityField.hasData()
    ) {
      return;
    }
    field?.setFilter(this.simulation.renderMode !== "raster");
    const domain =
      field?.manifest.encoding.kind === "vector-luma"
        ? field.manifest.encoding.valueDomain
        : 0;
    const minimum: [number, number] = field
      ? [-domain, -domain]
      : [this.velocityField.uMin, this.velocityField.vMin];
    const maximum: [number, number] = field
      ? [domain, domain]
      : [this.velocityField.uMax, this.velocityField.vMax];
    const geoBounds = field
      ? {
          west: field.bounds[0],
          south: field.bounds[1],
          east: field.bounds[2],
          north: field.bounds[3],
        }
      : this.velocityField.geoBounds;
    const pair: VelocityTexturePair | undefined = textures
      ? {
          a: {
            unit: 1,
            min: minimum,
            max: maximum,
            physical: true,
            northToSouth: true,
          },
          b: {
            unit: 4,
            min: minimum,
            max: maximum,
            physical: true,
            northToSouth: true,
          },
          mix: textures[2],
        }
      : undefined;
    const saved = saveGLState(gl);
    const textureBindings = textures
      ? [1, 4].map((unit) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          return gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
        })
      : [];

    try {
      const canvas = gl.canvas as HTMLCanvasElement;
      this.simulation.resize(canvas.width, canvas.height);
      // createFramebuffer (called inside resize) resets the FBO to null;
      // restore MapLibre's active render target before simulation captures it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, saved.framebuffer);

      // Bind velocity texture
      if (textures) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, textures[0]);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, textures[1]);
      } else {
        this.velocityField.bind(this.velocityTexUnit);
      }

      // MapLibre's matrix maps [0, worldSize] Mercator → clip space.
      // The draw shader does: worldPos = (pos + offset) * worldSize, then matrix * worldPos.
      const isGlobe = this.map.getProjection?.()?.type === "globe";

      // In globe mode particle Y encodes latitude linearly; in Mercator mode it's Web Mercator.
      const mapBounds = this.map.getBounds();
      const mercBounds = particleUpdateBounds(mapBounds, isGlobe);

      const worldCopyOffsets = visibleWorldCopyOffsets(mapBounds, isGlobe);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);

      const worldSize = 512 * Math.pow(2, this.map.getZoom());
      const center = this.map.getCenter();
      this.simulation.render(
        this.velocityTexUnit,
        minimum,
        maximum,
        matrix,
        mercBounds,
        worldSize,
        worldCopyOffsets,
        geoBounds,
        isGlobe,
        globeCenterVector(center.lng, center.lat),
        options.defaultProjectionData.clippingPlane,
        ...(pair ? ([pair] as const) : ([] as const)),
      );
    } finally {
      textureBindings.forEach((texture, index) => {
        gl.activeTexture(gl.TEXTURE0 + (index === 0 ? 1 : 4));
        gl.bindTexture(gl.TEXTURE_2D, texture);
      });
      restoreGLState(gl, saved);
    }

    if (this.pendingReadyTime != null) {
      const time = this.pendingReadyTime;
      this.pendingReadyTime = null;
      this.emit("status", { phase: "ready", time });
    }

    this.map.triggerRepaint();
  }

  onRemove(): void {
    this.playback?.destroy();
    this.generation++;
    this.requestId++;
    this.pendingReadyTime = null;
    if (this.map) {
      if (this.moveStartHandler) {
        this.map.off("movestart", this.moveStartHandler);
      }
      if (this.moveHandler) {
        this.map.off("move", this.moveHandler);
      }
      if (this.moveEndHandler) {
        this.map.off("moveend", this.moveEndHandler);
      }
    }
    this.zarrSourceValue?.cancelAll();
    this.simulation.destroy();
    this.velocityField.destroy();
    this.frameCache.clear();
    this.inflight.clear();
    this.map = null;
    this.gl = null;
  }

  // --- Public setters ---

  setTime(time: string | number): void {
    if (this.playback) {
      this.time = time;
      this.playback.setTime(time);
      return;
    }
    this.requestId++;
    this.pendingReadyTime = null;
    this.time = time;
    if (this.suspended) {
      return;
    }
    const ms = this.timeToMs(time);

    if (this.frameCache.has(ms)) {
      // Instant swap — no network round-trip needed.
      const data = this.frameCache.get(ms)!;
      this.emit("status", { phase: "rendering", time: ms });
      this.velocityField.update(data);
      this.emit("loaded", this.computeFieldMeta(data, time));
      this.pendingReadyTime = ms;
      this.map?.triggerRepaint();
    } else {
      this.loadViewportVelocity();
    }
  }

  setTimeAndDepth(time: string | number, depth: number): void {
    if (this.playback) {
      this.setTime(time);
      return;
    }
    this.requestId++;
    this.pendingReadyTime = null;
    const depthChanged = this.depth !== depth;
    this.time = time;
    this.depth = depth;

    if (depthChanged) {
      this.generation++;
      this.zarrSource.cancelAll();
      this.frameCache.clear();
      this.inflight.clear();
    }

    if (this.suspended) {
      return;
    }

    const ms = this.timeToMs(time);
    if (!depthChanged && this.frameCache.has(ms)) {
      const data = this.frameCache.get(ms)!;
      this.emit("status", { phase: "rendering", time: ms });
      this.velocityField.update(data);
      this.emit("loaded", this.computeFieldMeta(data, time));
      this.pendingReadyTime = ms;
      this.map?.triggerRepaint();
      return;
    }

    this.loadViewportVelocity();
  }

  /**
   * Pre-fetch velocity data for a future time step without swapping the active
   * field. Fires `frameBuffered(ms)` when ready so playback can advance
   * immediately without a loading gap. Rejects when the frame cannot be
   * loaded, so playback can stop instead of waiting for it.
   */
  async prefetchTime(ms: number): Promise<void> {
    if (this.playback) {
      await this.playback.field?.prime(ms);
      return;
    }
    if (this.suspended || !this.map || !this.initialized) {
      return;
    }
    if (this.frameCache.has(ms) || this.inflight.has(ms)) {
      return;
    }

    this.inflight.add(ms);
    const generation = this.generation;
    try {
      const data = await this.fetchVelocityData(ms);
      // Guard against cache being cleared (e.g. viewport change) while we were fetching.
      if (generation === this.generation && !this.frameCache.has(ms)) {
        this.frameCache.set(ms, data);
        this.emit("frameBuffered", ms);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        throw err;
      }
    } finally {
      this.inflight.delete(ms);
    }
  }

  /** True when the frame for the given time (ms) is already in the cache. */
  isFrameCached(ms: number): boolean {
    if (this.playback) {
      return this.playback.field?.ready(ms) ?? false;
    }
    return this.frameCache.has(ms);
  }

  /** Abort all pending Zarr prefetch fetches and clear the inflight set. */
  cancelPrefetches(): void {
    if (this.playback) {
      return;
    }
    this.zarrSource.cancelAll();
    this.inflight.clear();
  }

  suspend(): void {
    if (this.suspended) {
      return;
    }
    this.suspended = true;
    if (this.playback) {
      this.playback.suspend();
      return;
    }
    this.requestId++;
    this.pendingReadyTime = null;
    this.reloadQueued = false;
    this.reloadQueuedResetParticles = false;
    this.zarrSource.cancelAll();
    this.inflight.clear();
  }

  resume(): void {
    if (!this.suspended) {
      return;
    }
    this.suspended = false;
    if (this.playback) {
      this.playback.resume();
      return;
    }
    this.loadViewportVelocity({ resetParticles: true });
  }

  setDepth(depth: number): void {
    if (this.playback) {
      return;
    }
    this.requestId++;
    this.pendingReadyTime = null;
    this.depth = depth;
    this.generation++;
    this.zarrSource.cancelAll();
    this.frameCache.clear();
    this.inflight.clear();
    if (this.suspended) {
      return;
    }
    this.loadViewportVelocity();
  }

  async play(): Promise<void> {
    await this.playback?.play();
  }
  pause(): void {
    this.playback?.pause();
  }
  setLoop(loop: boolean): void {
    this.playback?.setLoop(loop);
  }
  setStepsPerSecond(value: number): void {
    this.playback?.setStepsPerSecond(value);
  }
  setTimeRange(range: [number, number]): void {
    this.playback?.setTimeRange(range);
  }
  replaceManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoPlaybackReplaceOptions = {},
  ): boolean {
    return this.playback?.replaceManifest(manifest, options) ?? false;
  }
  preloadManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoPlaybackReplaceOptions = {},
  ): boolean {
    return this.playback?.preloadManifest(manifest, options) ?? false;
  }

  setSpeed(v: number): void {
    this.simulation.setSpeed(v);
  }

  setFade(v: number): void {
    this.simulation.setFadeOpacity(fadeToOpacity(v));
  }

  setParticleDensity(density: number): void {
    this.simulation.setParticleDensity(density);
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

  setRgba8MaxParticleZoom(v: number): void {
    this.simulation.setRgba8MaxParticleZoom(v);
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

  setColorGrade(grade: Partial<ColorGrade>): void {
    this.simulation.setColorGrade(grade);
  }

  setBackdrop(backdrop: Partial<BackdropStyle>): void {
    this.simulation.setBackdrop(backdrop);
  }

  getDebugInfo(): VectorLayerDebugInfo {
    return {
      kind: "vector",
      id: this.id,
      initialized: this.initialized,
      loading: this.loading,
      variableU: this.variableU,
      variableV: this.variableV,
      time: this.time,
      depth: this.depth,
      unit: this.unit,
      simulation: this.simulation.getDebugInfo(),
    };
  }

  on<K extends keyof LayerEventMap>(event: K, handler: LayerEventMap[K]): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof LayerEventMap>(
    event: K,
    handler: LayerEventMap[K],
  ): this {
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

type FetchedChunk = {
  data: Float32Array;
  latStart: number;
  lonStart: number;
  latSize: number;
  lonSize: number;
  lonChunkSize: number;
};

function deriveVectorChunks(
  directionChunks: FetchedChunk[],
  magnitudeChunks: FetchedChunk[],
  derivation: NonNullable<VectorLayerOptions["vectorDerivation"]>,
): [FetchedChunk[], FetchedChunk[]] {
  const uChunks: FetchedChunk[] = [];
  const vChunks: FetchedChunk[] = [];

  for (let chunkIndex = 0; chunkIndex < directionChunks.length; chunkIndex++) {
    const directionChunk = directionChunks[chunkIndex];
    const magnitudeChunk = magnitudeChunks[chunkIndex];
    const u = new Float32Array(directionChunk.data.length);
    const v = new Float32Array(directionChunk.data.length);

    for (let i = 0; i < directionChunk.data.length; i++) {
      const components = deriveDirectionMagnitudeComponents(
        directionChunk.data[i],
        magnitudeChunk.data[i],
        derivation,
      );
      u[i] = components.u;
      v[i] = components.v;
    }

    uChunks.push({ ...directionChunk, data: u });
    vChunks.push({ ...directionChunk, data: v });
  }

  return [uChunks, vChunks];
}
