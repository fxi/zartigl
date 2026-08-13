import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";
import { createProgram, restoreGLState, saveGLState } from "./gl-util";
import { visibleWorldCopyOffsets } from "./geo-util";
import gridMercatorVert from "./shaders/grid_mercator.vert.glsl";
import gridGlobeVert from "./shaders/grid_globe.vert.glsl";
import geoVideoFrag from "./shaders/geovideo.frag.glsl";
import {
  geoVideoSecondsForTime,
  geoVideoTimeForSeconds,
  loadGeoVideoManifest,
  type GeoVideoManifestV1,
} from "./geovideo";
import type { FieldMeta } from "./types";
import type { ZartiglStatus } from "./load-status";

const GRID_LON_SEGMENTS = 128;
const GRID_LAT_SEGMENTS = 64;

type GeoVideoEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (error: Error) => void;
  status: (status: ZartiglStatus) => void;
  timeChange: (time: number) => void;
};

export interface GeoVideoLayerOptions {
  id: string;
  manifest: string | GeoVideoManifestV1;
  opacity?: number;
  autoplay?: boolean;
}

export interface GeoVideoLayerDebugInfo {
  kind: "scalar-geovideo";
  id: string;
  initialized: boolean;
  playing: boolean;
  currentTime: number;
  manifestId?: string;
  mediaUrl?: string;
  decodedFrames: number;
  bufferedFrames: number;
  skippedFrames: number;
  uploadedFrames: number;
  droppedFrames: number;
  lastUploadDurationMs: number;
}

interface VideoFrameMetadata {
  mediaTime?: number;
  presentedFrames?: number;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class GeoVideoLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private readonly source: string | GeoVideoManifestV1;
  private readonly autoplay: boolean;
  private opacity: number;
  private map: MaplibreMap | null = null;
  private gl: WebGLRenderingContext | null = null;
  private manifest: GeoVideoManifestV1 | null = null;
  private video: VideoWithFrameCallback | null = null;
  private colorTexture: WebGLTexture | null = null;
  private maskTexture: WebGLTexture | null = null;
  private colorCanvas: HTMLCanvasElement | null = null;
  private maskCanvas: HTMLCanvasElement | null = null;
  private colorContext: CanvasRenderingContext2D | null = null;
  private maskContext: CanvasRenderingContext2D | null = null;
  private mercatorProgram: WebGLProgram | null = null;
  private globeProgram: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCount = 0;
  private frameCallback: number | null = null;
  private repaintFrame: number | null = null;
  private frameDirty = false;
  private maskDirty = false;
  private colorTextureInitialized = false;
  private maskTextureInitialized = false;
  private maskCaptured = false;
  private hasVideoFrameCallback = false;
  private lastBufferedMediaTime = -1;
  private lastUploadedMediaTime = -1;
  private decodedFrames = 0;
  private bufferedFrames = 0;
  private skippedFrames = 0;
  private uploadedFrames = 0;
  private lastUploadDurationMs = 0;
  private abortController: AbortController | null = null;
  private resumePlayback = false;
  private listeners = new Map<keyof GeoVideoEventMap, Set<Function>>();

  constructor(options: GeoVideoLayerOptions) {
    this.id = options.id;
    this.source = options.manifest;
    this.opacity = options.opacity ?? 1;
    this.autoplay = options.autoplay ?? true;
  }

  async onAdd(map: MaplibreMap, gl: WebGLRenderingContext): Promise<void> {
    this.map = map;
    this.gl = gl;
    this.abortController = new AbortController();
    this.emit("loading");
    this.emit("status", { phase: "metadata" });
    try {
      this.manifest = await loadGeoVideoManifest(this.source, this.abortController.signal);
      const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (
        this.manifest.media.width > maxTextureSize ||
        this.manifest.media.height > maxTextureSize
      ) {
        throw new Error(
          `GeoVideo ${this.manifest.media.width}x${this.manifest.media.height} exceeds GPU texture limit ${maxTextureSize}`,
        );
      }
      this.initGl(gl);
      this.initVideo(this.manifest);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === "AbortError") return;
      this.emit("status", { phase: "error", error: err });
      this.emit("error", err);
      throw err;
    }
  }

  render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
    const manifest = this.manifest;
    const video = this.video;
    if (!manifest || !video || !this.colorTexture || !this.maskTexture) return;
    if (!this.hasVideoFrameCallback && video.currentTime !== this.lastBufferedMediaTime) {
      this.captureFrame();
    }
    const saved = saveGLState(gl);
    gl.activeTexture(gl.TEXTURE0);
    const previousTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.activeTexture(gl.TEXTURE1);
    const previousTexture1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    try {
      if (this.maskDirty && this.maskCanvas) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
        try {
          this.uploadCanvas(gl, this.maskCanvas, this.maskTextureInitialized);
          this.maskTextureInitialized = true;
          this.maskDirty = false;
        } catch {
          this.skippedFrames += 1;
          return;
        }
      }
      if (this.frameDirty && this.colorCanvas) {
        const uploadStarted = performance.now();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
        try {
          this.uploadCanvas(gl, this.colorCanvas, this.colorTextureInitialized);
        } catch {
          this.skippedFrames += 1;
          return;
        }
        this.colorTextureInitialized = true;
        this.lastUploadedMediaTime = this.lastBufferedMediaTime;
        this.uploadedFrames += 1;
        this.lastUploadDurationMs = performance.now() - uploadStarted;
        this.frameDirty = false;
      }
      if (!this.colorTextureInitialized || !this.maskTextureInitialized) return;
      const isGlobe = this.map?.getProjection?.()?.type === "globe";
      const program = isGlobe ? this.globeProgram : this.mercatorProgram;
      if (!program || !this.map) return;
      gl.useProgram(program);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
      gl.uniform1i(gl.getUniformLocation(program, "u_color"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
      gl.uniform1i(gl.getUniformLocation(program, "u_mask"), 1);
      gl.uniform1f(gl.getUniformLocation(program, "u_opacity"), this.opacity);
      gl.uniform2f(
        gl.getUniformLocation(program, "u_texel_size"),
        1 / manifest.media.width,
        1 / manifest.media.height,
      );
      gl.uniformMatrix4fv(
        gl.getUniformLocation(program, "u_matrix"),
        false,
        options.modelViewProjectionMatrix instanceof Float32Array
          ? options.modelViewProjectionMatrix
          : new Float32Array(Array.from(options.modelViewProjectionMatrix)),
      );
      const [west, south, rawEast, north] = manifest.bounds;
      const east = rawEast < west ? rawEast + 360 : rawEast;
      gl.uniform4f(gl.getUniformLocation(program, "u_geo_bounds"), west, south, east, north);
      this.bindGrid(gl, program);
      if (isGlobe) {
        const plane = options.defaultProjectionData.clippingPlane;
        gl.uniform4f(gl.getUniformLocation(program, "u_clipping_plane"), ...plane);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      } else {
        const worldSize = 512 * Math.pow(2, this.map.getZoom());
        gl.uniform1f(gl.getUniformLocation(program, "u_world_size"), worldSize);
        for (const offset of visibleWorldCopyOffsets(this.map.getBounds(), false)) {
          gl.uniform1f(gl.getUniformLocation(program, "u_world_offset"), offset);
          gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
        }
      }
      this.unbindGrid(gl, program);
    } finally {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture0);
      restoreGLState(gl, saved);
    }
  }

  onRemove(): void {
    this.abortController?.abort();
    this.abortController = null;
    const video = this.video;
    if (video) {
      video.pause();
      if (this.frameCallback != null) video.cancelVideoFrameCallback?.(this.frameCallback);
      video.removeAttribute("src");
      video.load();
    }
    this.stopRepaintLoop();
    this.frameCallback = null;
    if (this.gl) {
      if (this.colorTexture) this.gl.deleteTexture(this.colorTexture);
      if (this.maskTexture) this.gl.deleteTexture(this.maskTexture);
      if (this.mercatorProgram) this.gl.deleteProgram(this.mercatorProgram);
      if (this.globeProgram) this.gl.deleteProgram(this.globeProgram);
      if (this.vertexBuffer) this.gl.deleteBuffer(this.vertexBuffer);
      if (this.indexBuffer) this.gl.deleteBuffer(this.indexBuffer);
    }
    this.video = null;
    this.colorTexture = null;
    this.maskTexture = null;
    this.colorCanvas = null;
    this.maskCanvas = null;
    this.colorContext = null;
    this.maskContext = null;
    this.colorTextureInitialized = false;
    this.maskTextureInitialized = false;
    this.maskCaptured = false;
    this.hasVideoFrameCallback = false;
    this.lastBufferedMediaTime = -1;
    this.lastUploadedMediaTime = -1;
    this.mercatorProgram = null;
    this.globeProgram = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.map = null;
    this.gl = null;
  }

  setTime(time: string | number): void {
    if (!this.video || !this.manifest) return;
    const ms = typeof time === "number" ? time : new Date(time).getTime();
    this.video.currentTime = geoVideoSecondsForTime(this.manifest, ms);
    this.map?.triggerRepaint();
  }

  setTimeAndDepth(time: string | number, _depth: number): void { this.setTime(time); }
  setDepth(_depth: number): void {}
  async prefetchTime(_ms: number): Promise<void> {}
  isFrameCached(_ms: number): boolean { return true; }
  cancelPrefetches(): void {}
  suspend(): void {
    this.resumePlayback = this.video != null && !this.video.paused;
    this.pause();
  }
  resume(): void {
    if (this.resumePlayback) void this.play();
    this.resumePlayback = false;
  }
  setRgba8MaxParticleZoom(_value: number): void {}
  setColorRamp(_ramp: unknown): void {}
  setLogScale(_value: boolean): void {}
  setVibrance(_value: number): void {}
  setColorDomain(_domain: [number, number] | null): void {}

  setOpacity(value: number): void {
    this.opacity = Math.max(0, Math.min(1, value));
    this.map?.triggerRepaint();
  }

  async play(): Promise<void> {
    await this.video?.play();
  }

  pause(): void {
    this.video?.pause();
  }

  getManifest(): GeoVideoManifestV1 | null { return this.manifest; }

  getDebugInfo(): GeoVideoLayerDebugInfo {
    return {
      kind: "scalar-geovideo",
      id: this.id,
      initialized: this.manifest != null && this.colorTexture != null && this.maskTexture != null,
      playing: this.video != null && !this.video.paused,
      currentTime: this.video?.currentTime ?? 0,
      manifestId: this.manifest?.id,
      mediaUrl: this.manifest?.media.url,
      decodedFrames: this.decodedFrames,
      bufferedFrames: this.bufferedFrames,
      skippedFrames: this.skippedFrames,
      uploadedFrames: this.uploadedFrames,
      droppedFrames: this.video?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      lastUploadDurationMs: this.lastUploadDurationMs,
    };
  }

  on<K extends keyof GeoVideoEventMap>(event: K, handler: GeoVideoEventMap[K]): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof GeoVideoEventMap>(event: K, handler: GeoVideoEventMap[K]): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  private initGl(gl: WebGLRenderingContext): void {
    this.mercatorProgram = createProgram(gl, gridMercatorVert, geoVideoFrag);
    this.globeProgram = createProgram(gl, gridGlobeVert, geoVideoFrag);
    this.colorTexture = this.createVideoTexture(gl);
    this.maskTexture = this.createVideoTexture(gl);
    const vertices = new Float32Array((GRID_LON_SEGMENTS + 1) * (GRID_LAT_SEGMENTS + 1) * 2);
    let vertex = 0;
    for (let y = 0; y <= GRID_LAT_SEGMENTS; y++) {
      for (let x = 0; x <= GRID_LON_SEGMENTS; x++) {
        vertices[vertex++] = x / GRID_LON_SEGMENTS;
        vertices[vertex++] = y / GRID_LAT_SEGMENTS;
      }
    }
    const indices = new Uint16Array(GRID_LON_SEGMENTS * GRID_LAT_SEGMENTS * 6);
    let index = 0;
    const stride = GRID_LON_SEGMENTS + 1;
    for (let y = 0; y < GRID_LAT_SEGMENTS; y++) {
      for (let x = 0; x < GRID_LON_SEGMENTS; x++) {
        const a = y * stride + x;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        indices[index++] = a; indices[index++] = c; indices[index++] = b;
        indices[index++] = b; indices[index++] = c; indices[index++] = d;
      }
    }
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    if (!this.vertexBuffer || !this.indexBuffer) throw new Error("Failed to create GeoVideo grid");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexCount = indices.length;
  }

  private initVideo(manifest: GeoVideoManifestV1): void {
    this.colorCanvas = document.createElement("canvas");
    this.maskCanvas = document.createElement("canvas");
    this.colorCanvas.width = this.maskCanvas.width = manifest.media.width;
    this.colorCanvas.height = this.maskCanvas.height = manifest.media.height;
    this.colorContext = this.colorCanvas.getContext("2d", { alpha: false });
    this.maskContext = this.maskCanvas.getContext("2d", { alpha: false });
    if (!this.colorContext || !this.maskContext) {
      throw new Error("Failed to create GeoVideo frame buffers");
    }
    const video = document.createElement("video") as VideoWithFrameCallback;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = manifest.media.url;
    video.addEventListener("loadeddata", () => {
      if (
        video.videoWidth !== manifest.media.packedWidth ||
        video.videoHeight !== manifest.media.packedHeight
      ) {
        const error = new Error(
          `GeoVideo media dimensions ${video.videoWidth}x${video.videoHeight} do not match manifest ` +
          `${manifest.media.packedWidth}x${manifest.media.packedHeight}`,
        );
        this.emit("status", { phase: "error", error });
        this.emit("error", error);
        return;
      }
      this.captureFrame();
      const time = geoVideoTimeForSeconds(manifest, video.currentTime);
      this.emit("loaded", {
        min: manifest.style.colorDomain[0],
        max: manifest.style.colorDomain[1],
        unit: manifest.style.unit ?? "",
        time: new Date(time).toISOString(),
      });
      this.emit("status", { phase: "ready", time });
      this.map?.triggerRepaint();
      if (this.autoplay) void video.play().catch(() => undefined);
    }, { once: true });
    video.addEventListener("error", () => {
      const error = new Error(`Failed to load GeoVideo media: ${manifest.media.url}`);
      this.emit("status", { phase: "error", error });
      this.emit("error", error);
    });
    video.addEventListener("playing", () => this.startRepaintLoop());
    video.addEventListener("pause", () => this.stopRepaintLoop());
    video.addEventListener("waiting", () => this.stopRepaintLoop());
    video.addEventListener("ended", () => this.stopRepaintLoop());
    this.video = video;
    const markFrame = (_now?: number, metadata?: VideoFrameMetadata) => {
      if (!this.video) return;
      this.decodedFrames = metadata?.presentedFrames ?? this.decodedFrames + 1;
      this.captureFrame();
      const time = geoVideoTimeForSeconds(manifest, video.currentTime);
      this.emit("timeChange", time);
      this.map?.triggerRepaint();
      this.frameCallback = video.requestVideoFrameCallback?.(markFrame) ?? null;
    };
    this.hasVideoFrameCallback = typeof video.requestVideoFrameCallback === "function";
    if (this.hasVideoFrameCallback) this.frameCallback = video.requestVideoFrameCallback!(markFrame);
    else video.addEventListener("timeupdate", () => markFrame());
    video.load();
  }

  private captureFrame(): boolean {
    const video = this.video;
    const manifest = this.manifest;
    const colorContext = this.colorContext;
    const maskContext = this.maskContext;
    if (
      !video || !manifest || !colorContext || !maskContext ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) return false;
    const { width, height } = manifest.media;
    try {
      colorContext.drawImage(video, 0, 0, width, height, 0, 0, width, height);
      if (!this.maskCaptured) {
        maskContext.drawImage(video, width, 0, width, height, 0, 0, width, height);
        this.maskCaptured = true;
        this.maskDirty = true;
      }
      this.lastBufferedMediaTime = video.currentTime;
      this.frameDirty = true;
      this.bufferedFrames += 1;
      return true;
    } catch {
      this.skippedFrames += 1;
      return false;
    }
  }

  private createVideoTexture(gl: WebGLRenderingContext): WebGLTexture {
    const texture = gl.createTexture();
    if (!texture) throw new Error("Failed to create GeoVideo texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  private uploadCanvas(
    gl: WebGLRenderingContext,
    canvas: HTMLCanvasElement,
    initialized: boolean,
  ): void {
    const unpackFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    try {
      if (initialized) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      }
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, unpackFlipY ? 1 : 0);
    }
  }

  private startRepaintLoop(): void {
    if (this.repaintFrame != null || !this.map) return;
    const repaint = () => {
      this.repaintFrame = null;
      if (!this.map || !this.video || this.video.paused || this.video.ended) return;
      this.map.triggerRepaint();
      this.repaintFrame = requestAnimationFrame(repaint);
    };
    this.map.triggerRepaint();
    this.repaintFrame = requestAnimationFrame(repaint);
  }

  private stopRepaintLoop(): void {
    if (this.repaintFrame == null) return;
    cancelAnimationFrame(this.repaintFrame);
    this.repaintFrame = null;
  }

  private bindGrid(gl: WebGLRenderingContext, program: WebGLProgram): void {
    const location = gl.getAttribLocation(program, "a_grid_uv");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
  }

  private unbindGrid(gl: WebGLRenderingContext, program: WebGLProgram): void {
    gl.disableVertexAttribArray(gl.getAttribLocation(program, "a_grid_uv"));
  }

  private emit<K extends keyof GeoVideoEventMap>(event: K, ...args: Parameters<GeoVideoEventMap[K]>): void {
    for (const handler of this.listeners.get(event) ?? []) (handler as Function)(...args);
  }
}
