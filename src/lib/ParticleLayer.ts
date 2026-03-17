import type {
  Map as MaplibreMap,
  CustomLayerInterface,
  CustomRenderMethodInput,
} from "maplibre-gl";
import type { ParticleLayerOptions, ZoomWeighted, FieldMeta } from "./types.js";
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

  private initialized = false;
  private loading = false;
  // Unit 0: particles state, Unit 1: velocity, Unit 2: color ramp
  private velocityTexUnit = 1;
  private moveStartHandler: (() => void) | null = null;
  private moveEndHandler: (() => void) | null = null;

  private listeners: Map<string, Set<Function>> = new Map();

  constructor(options: ParticleLayerOptions) {
    this.id = options.id;

    this.variableU = options.variableU ?? "uo";
    this.variableV = options.variableV ?? "vo";
    this.time = options.time ?? 0;
    this.depth = options.depth ?? 0;

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

    // On settle: clear trail history, randomise particle positions, reload velocity.
    this.moveEndHandler = () => {
      this.simulation.clearState();
      this.simulation.resetParticles();
      this.loadViewportVelocity();
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

  private async loadViewportVelocity(): Promise<void> {
    if (this.loading || !this.map) return;
    this.loading = true;
    this.emit('loading');

    try {
      const bounds = this.map.getBounds();
      // Always load the full longitude range so the velocity texture covers
      // [-180, 180] end-to-end. This makes the REPEAT wrap and fract(geoUV.x)
      // in the update shader geometrically correct: the left and right edges of
      // the texture correspond to the same geographic line (the date line), so
      // bilinear interpolation and particle position wrapping are seamless.
      const geoBounds = {
        west: -180,
        east: 180,
        south: Math.max(bounds.getSouth(), -85),
        north: Math.min(bounds.getNorth(), 85),
      };

      const timeIdx =
        typeof this.time === "string" || typeof this.time === "number"
          ? this.zarrSource.findTimeIndex(this.time)
          : 0;
      const depthIdx = this.zarrSource.findDepthIndex(this.depth);

      const debugCoords = this.zarrSource.getCoords();
      console.log(
        `[zartigl] Loading velocity: depth=${this.depth} → depthIdx=${depthIdx}, ` +
        `actual depth value=${debugCoords.vertical[depthIdx]}, ` +
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

      // Fetch all U and V chunks in parallel
      const uPromises = uChunkInfos.map(async (info) => {
        const indices: number[] = [];
        indices[timeDim] = info.timeIdx;
        indices[depthDim] = info.depthIdx;
        indices[latDim] = info.latIdx;
        indices[lonDim] = info.lonIdx;
        const data = await this.zarrSource.fetchChunk(
          this.variableU,
          indices,
        );
        const lonChunkSize = this.zarrSource.getChunkShape(this.variableU)[lonDim];
        return {
          data,
          latStart:
            info.latIdx * this.zarrSource.getChunkShape(this.variableU)[latDim],
          lonStart:
            info.lonIdx * lonChunkSize,
          latSize: info.latSize,
          lonSize: info.lonSize,
          lonChunkSize,
        };
      });

      const vPromises = uChunkInfos.map(async (info) => {
        const indices: number[] = [];
        indices[timeDim] = info.timeIdx;
        indices[depthDim] = info.depthIdx;
        indices[latDim] = info.latIdx;
        indices[lonDim] = info.lonIdx;
        const data = await this.zarrSource.fetchChunk(
          this.variableV,
          indices,
        );
        const lonChunkSize = this.zarrSource.getChunkShape(this.variableV)[lonDim];
        return {
          data,
          latStart:
            info.latIdx * this.zarrSource.getChunkShape(this.variableV)[latDim],
          lonStart:
            info.lonIdx * lonChunkSize,
          latSize: info.latSize,
          lonSize: info.lonSize,
          lonChunkSize,
        };
      });

      const [uChunks, vChunks] = await Promise.all([
        Promise.all(uPromises),
        Promise.all(vPromises),
      ]);

      // Compute the pixel extent covered by the fetched chunks only.
      // Using the full dataset shape would leave NaN holes outside the
      // viewport, causing particles there to be dropped and re-spawned
      // as stripe artifacts.
      const latPixMin = Math.min(...uChunks.map(c => c.latStart));
      const latPixMax = Math.max(...uChunks.map(c => c.latStart + c.latSize));
      const lonPixMin = Math.min(...uChunks.map(c => c.lonStart));
      const lonPixMax = Math.max(...uChunks.map(c => c.lonStart + c.lonSize));
      const fetchedHeight = latPixMax - latPixMin;
      const fetchedWidth  = lonPixMax - lonPixMin;

      // Offset chunk positions to be relative to the fetched sub-region.
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

      // Geographic bounds of the fetched sub-region.
      const coords = this.zarrSource.getCoords();
      const latLast = Math.min(latPixMax - 1, coords.latitude.length - 1);
      const lonLast = Math.min(lonPixMax - 1, coords.longitude.length - 1);
      const dataGeoBounds = {
        west:  coords.longitude[lonPixMin],
        east:  coords.longitude[lonLast],
        south: Math.min(coords.latitude[latPixMin], coords.latitude[latLast]),
        north: Math.max(coords.latitude[latPixMin], coords.latitude[latLast]),
      };
      // Detect north-to-south latitude storage (needs Y-flip in GL texture).
      const latDescending = coords.latitude[latPixMin] > coords.latitude[latLast];

      const velocityData = stitchVelocityChunks(
        uChunksRel,
        vChunksRel,
        fetchedHeight,
        fetchedWidth,
        dataGeoBounds,
        latDescending,
      );

      this.velocityField.update(velocityData);

      // Compute field meta and emit 'loaded'
      const maxSpeed = Math.sqrt(
        Math.max(velocityData.uMin ** 2, velocityData.uMax ** 2) +
        Math.max(velocityData.vMin ** 2, velocityData.vMax ** 2),
      );
      const timeStr =
        typeof this.time === "string"
          ? this.time
          : new Date(this.time).toISOString();
      this.emit('loaded', {
        min: 0,
        max: maxSpeed,
        unit: 'm/s',
        time: timeStr,
        depth: this.depth,
      });

      this.map?.triggerRepaint();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[zartigl] Failed to load velocity:", err);
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
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
    this.loadViewportVelocity();
  }

  setDepth(depth: number): void {
    this.depth = depth;
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
