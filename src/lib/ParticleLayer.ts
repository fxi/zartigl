import type {
  Map as MaplibreMap,
  CustomLayerInterface,
  CustomRenderMethodInput,
} from "maplibre-gl";
import type { ParticleLayerOptions } from "./types.js";
import { saveGLState, restoreGLState } from "./gl-util.js";
import { ParticleSimulation } from "./ParticleSimulation.js";
import { VelocityField, stitchVelocityChunks } from "./VelocityField.js";
import { ZarrSource } from "./ZarrSource.js";

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

  private opts: Required<
    Pick<
      ParticleLayerOptions,
      "variableU" | "variableV" | "time" | "depth" | "speedFactor"
    >
  > &
    ParticleLayerOptions;

  private initialized = false;
  private loading = false;
  private velocityTexUnit = 1;
  private moveEndHandler: (() => void) | null = null;

  constructor(options: ParticleLayerOptions) {
    this.id = options.id;
    this.opts = {
      variableU: "uo",
      variableV: "vo",
      time: 0,
      depth: 0,
      speedFactor: 0.25,
      ...options,
    };

    this.zarrSource = new ZarrSource(options.source);
    this.velocityField = new VelocityField();
    this.simulation = new ParticleSimulation({
      particleCount: options.particleCount ?? 65536,
      speedFactor: this.opts.speedFactor,
      fadeOpacity: options.fadeOpacity ?? 0.996,
      dropRate: options.dropRate ?? 0.003,
      dropRateBump: options.dropRateBump ?? 0.01,
      pointSize: options.pointSize ?? 1.0,
      colorRamp: options.colorRamp,
    });
  }

  async onAdd(map: MaplibreMap, gl: WebGLRenderingContext): Promise<void> {
    this.map = map;
    this.gl = gl;

    this.simulation.init(gl);
    this.velocityField.init(gl);

    // Load Zarr metadata and initial velocity data
    this.initAsync();

    // Reload velocity data when the map moves
    this.moveEndHandler = () => this.loadViewportVelocity();
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

    try {
      const bounds = this.map.getBounds();
      const geoBounds = {
        west: Math.max(bounds.getWest(), -180),
        south: Math.max(bounds.getSouth(), -85),
        east: Math.min(bounds.getEast(), 180),
        north: Math.min(bounds.getNorth(), 85),
      };

      const timeIdx =
        typeof this.opts.time === "string" || typeof this.opts.time === "number"
          ? this.zarrSource.findTimeIndex(this.opts.time)
          : 0;
      const depthIdx = this.zarrSource.findDepthIndex(this.opts.depth);

      const uChunkInfos = this.zarrSource.getChunksForBounds(
        this.opts.variableU,
        timeIdx,
        depthIdx,
        geoBounds,
      );

      const dims = this.zarrSource.getDimensions(this.opts.variableU);
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
          this.opts.variableU,
          indices,
        );
        return {
          data,
          latStart:
            info.latIdx * this.zarrSource.getChunkShape(this.opts.variableU)[latDim],
          lonStart:
            info.lonIdx * this.zarrSource.getChunkShape(this.opts.variableU)[lonDim],
          latSize: info.latSize,
          lonSize: info.lonSize,
        };
      });

      const vPromises = uChunkInfos.map(async (info) => {
        const indices: number[] = [];
        indices[timeDim] = info.timeIdx;
        indices[depthDim] = info.depthIdx;
        indices[latDim] = info.latIdx;
        indices[lonDim] = info.lonIdx;
        const data = await this.zarrSource.fetchChunk(
          this.opts.variableV,
          indices,
        );
        return {
          data,
          latStart:
            info.latIdx * this.zarrSource.getChunkShape(this.opts.variableV)[latDim],
          lonStart:
            info.lonIdx * this.zarrSource.getChunkShape(this.opts.variableV)[lonDim],
          latSize: info.latSize,
          lonSize: info.lonSize,
        };
      });

      const [uChunks, vChunks] = await Promise.all([
        Promise.all(uPromises),
        Promise.all(vPromises),
      ]);

      const shape = this.zarrSource.getShape(this.opts.variableU);
      const totalLat = shape[latDim];
      const totalLon = shape[lonDim];

      // Compute actual geographic bounds from coordinate arrays
      const coords = this.zarrSource.getCoords();
      const dataGeoBounds = {
        west: coords.longitude[0],
        south: Math.min(coords.latitude[0], coords.latitude[coords.latitude.length - 1]),
        east: coords.longitude[coords.longitude.length - 1],
        north: Math.max(coords.latitude[0], coords.latitude[coords.latitude.length - 1]),
      };

      const velocityData = stitchVelocityChunks(
        uChunks,
        vChunks,
        totalLat,
        totalLon,
        dataGeoBounds,
      );

      this.velocityField.update(velocityData);
      this.map?.triggerRepaint();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[zartigl] Failed to load velocity:", err);
      }
    } finally {
      this.loading = false;
    }
  }

  render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
    const matrix = options.modelViewProjectionMatrix;
    if (!this.initialized || !this.velocityField.hasData() || !this.map) return;

    const saved = saveGLState(gl);

    try {
      const canvas = gl.canvas as HTMLCanvasElement;
      this.simulation.resize(canvas.width, canvas.height);

      // Bind velocity texture
      this.velocityField.bind(this.velocityTexUnit);

      // Get viewport bounds in mercator [0,1] coordinates
      const mapBounds = this.map.getBounds();
      const mercBounds = {
        minX: lngToMercX(Math.max(mapBounds.getWest(), -180)),
        minY: latToMercY(Math.min(mapBounds.getNorth(), 85)),
        maxX: lngToMercX(Math.min(mapBounds.getEast(), 180)),
        maxY: latToMercY(Math.max(mapBounds.getSouth(), -85)),
      };

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);

      const worldSize = 512 * Math.pow(2, this.map.getZoom());
      this.simulation.render(
        this.velocityTexUnit,
        [this.velocityField.uMin, this.velocityField.vMin],
        [this.velocityField.uMax, this.velocityField.vMax],
        matrix,
        mercBounds,
        worldSize,
        this.velocityField.geoBounds,
      );
    } finally {
      restoreGLState(gl, saved);
    }

    this.map.triggerRepaint();
  }

  onRemove(): void {
    if (this.map && this.moveEndHandler) {
      this.map.off("moveend", this.moveEndHandler);
    }
    this.zarrSource.cancelAll();
    this.simulation.destroy();
    this.velocityField.destroy();
    this.map = null;
    this.gl = null;
  }

  // --- Public setters ---

  setTime(time: string | number): void {
    this.opts.time = time;
    this.simulation.resetParticles();
    this.loadViewportVelocity();
  }

  setDepth(depth: number): void {
    this.opts.depth = depth;
    this.simulation.resetParticles();
    this.loadViewportVelocity();
  }

  setSpeedFactor(v: number): void {
    this.opts.speedFactor = v;
    this.simulation.setSpeedFactor(v);
  }

  setFadeOpacity(v: number): void {
    this.simulation.setFadeOpacity(v);
  }

  setDropRate(v: number): void {
    this.simulation.setDropRate(v);
  }

  setDropRateBump(v: number): void {
    this.simulation.setDropRateBump(v);
  }

  setPointSize(v: number): void {
    this.simulation.setPointSize(v);
  }

  setParticleCount(count: number): void {
    this.simulation.setParticleCount(count);
  }

  setColorRamp(ramp: Record<number, string>): void {
    this.simulation.setColorRamp(ramp);
  }
}
