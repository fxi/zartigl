import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";
import {
  createColorRampTexture,
  createProgram,
  requireWebGL2,
  resolveColorRamp,
  restoreGLState,
  saveGLState,
  type ColorRampInput,
} from "./gl-util";
import { visibleWorldCopyOffsets } from "./geo-util";
import { geoVideoScalarUniforms } from "./GeoVideoScalarSource";
import gridMercatorVert from "./shaders/grid_mercator.vert.glsl";
import gridGlobeVert from "./shaders/grid_globe.vert.glsl";
import geoVideoFrag from "./shaders/geovideo.frag.glsl";
import {
  geoVideoSecondsForTime,
  loadGeoVideoManifest,
  type GeoVideoManifest,
  type GeoVideoScalarEncoding,
} from "./geovideo";

import {
  GeoVideoPlayback,
  type GeoVideoPlaybackReplaceOptions,
  type GeoVideoPlaybackEvents,
} from "./GeoVideoPlayback";

const GRID_LON_SEGMENTS = 128;
const GRID_LAT_SEGMENTS = 64;

type GeoVideoEventMap = GeoVideoPlaybackEvents;

export interface GeoVideoLayerOptions {
  id: string;
  manifest: string | GeoVideoManifest;
  opacity?: number;
  autoplay?: boolean;
  loop?: boolean;
  playbackRate?: number;
  time?: string | number;
  timeRange?: [number, number];
  colorRamp?: ColorRampInput;
  colorDomain?: [number, number] | null;
  logScale?: boolean;
  vibrance?: number;
}

/**
 * Playback state for an artifact swapped in with `replaceManifest`, or
 * loaded ahead with `preloadManifest`.
 */
export type GeoVideoReplaceOptions = GeoVideoPlaybackReplaceOptions;

export interface GeoVideoLayerDebugInfo {
  kind: "scalar-geovideo";
  id: string;
  initialized: boolean;
  playing: boolean;
  currentTime: number;
  manifestId?: string;
  mediaUrl?: string;
  /** Media loaded ahead for the next swap. */
  preloadedMediaUrl?: string;
  decodedFrames: number;
  bufferedFrames: number;
  skippedFrames: number;
  uploadedFrames: number;
  droppedFrames: number;
  lastUploadDurationMs: number;
  frameCallbackCount: number;
  presentedFps: number;
  lastFrameAgeMs: number | null;
  readyState: number;
  networkState: number;
}

export class GeoVideoLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private readonly source: string | GeoVideoManifest;
  private readonly playback: GeoVideoPlayback;
  private opacity: number;
  private colorRamp: ColorRampInput;
  private colorDomain: [number, number] | null;
  private logScale: boolean;
  private vibrance: number;
  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private manifest: GeoVideoManifest | null = null;
  private colorRampTexture: WebGLTexture | null = null;
  private mercatorProgram: WebGLProgram | null = null;
  private globeProgram: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCount = 0;
  private abortController: AbortController | null = null;
  private listeners = new Map<keyof GeoVideoEventMap, Set<Function>>();

  constructor(options: GeoVideoLayerOptions) {
    this.id = options.id;
    this.source = options.manifest;
    this.opacity = options.opacity ?? 1;
    this.playback = new GeoVideoPlayback(
      options,
      () => this.map?.triggerRepaint(),
      (event, ...args) => this.emit(event, ...args),
    );
    this.colorRamp = options.colorRamp ?? "balance";
    this.colorDomain = options.colorDomain ?? null;
    this.logScale = options.logScale ?? false;
    this.vibrance = options.vibrance ?? 0;
  }

  async onAdd(
    map: MaplibreMap,
    context: WebGLRenderingContext | WebGL2RenderingContext,
  ): Promise<void> {
    const gl = requireWebGL2(context);
    this.map = map;
    this.gl = gl;
    this.abortController = new AbortController();
    this.emit("loading");
    this.emit("status", { phase: "metadata" });
    try {
      this.manifest = await loadGeoVideoManifest(
        this.source,
        this.abortController.signal,
      );
      if (this.abortController?.signal.aborted || !this.map) {
        return;
      }
      if (this.manifest.encoding.kind !== "scalar-luma") {
        throw new Error(
          `GeoVideoLayer renders scalar-luma manifests, received ${this.manifest.encoding.kind}`,
        );
      }
      if (this.colorDomain == null) {
        this.colorDomain = this.manifest.style.colorDomain;
      }
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
      if (this.abortController.signal.aborted) {
        return;
      }
      await this.playback.load(gl, this.manifest);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === "AbortError") {
        return;
      }
      this.emit("status", { phase: "error", error: err });
      this.emit("error", err);
      throw err;
    }
  }

  render(
    context: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    const gl = requireWebGL2(context);
    const pair = this.playback.sample(performance.now());
    const field = this.playback.field;
    if (!field) {
      return;
    }
    const manifest = field.manifest;
    if (!pair || !field.maskTexture) {
      return;
    }
    const saved = saveGLState(gl);
    const textures = [0, 1, 2, 3].map((unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      return gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    });
    try {
      const isGlobe = this.map?.getProjection?.()?.type === "globe";
      const program = isGlobe ? this.globeProgram : this.mercatorProgram;
      if (!program || !this.map) {
        return;
      }
      gl.useProgram(program);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pair[0]);
      gl.uniform1i(gl.getUniformLocation(program, "u_color"), 0);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, pair[1]);
      gl.uniform1i(gl.getUniformLocation(program, "u_color_next"), 3);
      gl.uniform1f(gl.getUniformLocation(program, "u_mix"), pair[2]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, field.maskTexture);
      gl.uniform1i(gl.getUniformLocation(program, "u_mask"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.colorRampTexture);
      gl.uniform1i(gl.getUniformLocation(program, "u_color_ramp"), 2);
      gl.uniform1f(gl.getUniformLocation(program, "u_opacity"), this.opacity);
      gl.uniform1f(gl.getUniformLocation(program, "u_scalar_luma"), 1);
      gl.uniform1f(
        gl.getUniformLocation(program, "u_log_scale"),
        this.logScale ? 1 : 0,
      );
      gl.uniform1f(gl.getUniformLocation(program, "u_vibrance"), this.vibrance);
      gl.uniform1f(
        gl.getUniformLocation(program, "u_mask_threshold"),
        manifest.mask.threshold,
      );
      const { codeRange, valueRange, transfer } = geoVideoScalarUniforms(
        manifest.encoding as GeoVideoScalarEncoding,
      );
      gl.uniform1f(
        gl.getUniformLocation(program, "u_scalar_transfer"),
        transfer,
      );
      const domain = this.colorDomain ?? valueRange;
      gl.uniform2f(
        gl.getUniformLocation(program, "u_code_range"),
        ...codeRange,
      );
      gl.uniform2f(
        gl.getUniformLocation(program, "u_value_range"),
        ...valueRange,
      );
      gl.uniform2f(
        gl.getUniformLocation(program, "u_color_domain"),
        domain[0],
        domain[1],
      );
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
      gl.uniform4f(
        gl.getUniformLocation(program, "u_geo_bounds"),
        west,
        south,
        east,
        north,
      );
      this.bindGrid(gl, program);
      if (isGlobe) {
        const plane = options.defaultProjectionData.clippingPlane;
        gl.uniform4f(
          gl.getUniformLocation(program, "u_clipping_plane"),
          ...plane,
        );
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      } else {
        const worldSize = 512 * Math.pow(2, this.map.getZoom());
        gl.uniform1f(gl.getUniformLocation(program, "u_world_size"), worldSize);
        for (const offset of visibleWorldCopyOffsets(
          this.map.getBounds(),
          false,
        )) {
          gl.uniform1f(
            gl.getUniformLocation(program, "u_world_offset"),
            offset,
          );
          gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
        }
      }
      this.unbindGrid(gl, program);
    } finally {
      textures.forEach((texture, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
      });
      restoreGLState(gl, saved);
    }
  }

  onRemove(): void {
    this.abortController?.abort();
    this.playback.destroy();
    if (this.gl) {
      this.gl.deleteTexture(this.colorRampTexture);
      this.gl.deleteProgram(this.mercatorProgram);
      this.gl.deleteProgram(this.globeProgram);
      this.gl.deleteBuffer(this.vertexBuffer);
      this.gl.deleteBuffer(this.indexBuffer);
    }
    this.colorRampTexture = null;
    this.mercatorProgram = null;
    this.globeProgram = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.map = null;
    this.gl = null;
  }

  setTime(time: string | number): void {
    this.playback.setTime(time);
  }
  replaceManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoReplaceOptions = {},
  ): boolean {
    if (!this.playback.replaceManifest(manifest, options)) {
      return false;
    }
    this.manifest = manifest;
    return true;
  }
  preloadManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoReplaceOptions = {},
  ): boolean {
    return this.playback.preloadManifest(manifest, options);
  }

  setTimeAndDepth(time: string | number, _depth: number): void {
    this.setTime(time);
  }
  setDepth(_depth: number): void {}
  async prefetchTime(ms: number): Promise<void> {
    await this.playback.field?.prime(ms);
  }
  isFrameCached(ms: number): boolean {
    return this.playback.field?.ready(ms) ?? false;
  }
  cancelPrefetches(): void {}
  suspend(): void {
    this.playback.suspend();
  }
  resume(): void {
    this.playback.resume();
  }
  setRgba8MaxParticleZoom(_value: number): void {}
  setColorRamp(ramp: ColorRampInput): void {
    this.colorRamp = ramp;
    if (this.gl) {
      if (this.colorRampTexture) {
        this.gl.deleteTexture(this.colorRampTexture);
      }
      this.colorRampTexture = createColorRampTexture(
        this.gl,
        resolveColorRamp(ramp),
      );
    }
    this.map?.triggerRepaint();
  }
  setLogScale(value: boolean): void {
    this.logScale = value;
    this.map?.triggerRepaint();
  }
  setVibrance(value: number): void {
    this.vibrance = value;
    this.map?.triggerRepaint();
  }
  setColorDomain(domain: [number, number] | null): void {
    this.colorDomain = domain ?? this.manifest?.style.colorDomain ?? null;
    this.map?.triggerRepaint();
  }

  setOpacity(value: number): void {
    this.opacity = Math.max(0, Math.min(1, value));
    this.map?.triggerRepaint();
  }

  async play(): Promise<void> {
    await this.playback.play();
  }
  pause(): void {
    this.playback.pause();
  }
  setLoop(loop: boolean): void {
    this.playback.setLoop(loop);
  }
  setPlaybackRate(rate: number): void {
    this.playback.setPlaybackRate(rate);
  }
  setTimeRange(range: [number, number]): void {
    this.playback.setTimeRange(range);
  }

  getManifest(): GeoVideoManifest | null {
    return this.manifest;
  }

  getDebugInfo(): GeoVideoLayerDebugInfo {
    const field = this.playback.field;
    return {
      kind: "scalar-geovideo",
      id: this.id,
      initialized: !!field?.currentPair,
      playing: this.playback.isPlaying(),
      currentTime: field
        ? field.manifest.timeline.kind === "snapshot-loop"
          ? (this.playback.time - field.times[0]) / 1000
          : geoVideoSecondsForTime(field.manifest, this.playback.time)
        : 0,
      manifestId: this.manifest?.id,
      mediaUrl: this.manifest?.media.url,
      preloadedMediaUrl: this.playback.preloadedMediaUrl,
      decodedFrames: field?.uploadedFrames ?? 0,
      bufferedFrames: field?.cachedFrames ?? 0,
      skippedFrames: 0,
      uploadedFrames: field?.uploadedFrames ?? 0,
      droppedFrames: 0,
      lastUploadDurationMs: field?.lastUploadDurationMs ?? 0,
      frameCallbackCount: 0,
      presentedFps: 0,
      lastFrameAgeMs: null,
      readyState: field?.currentPair ? 2 : 0,
      networkState: 0,
    };
  }

  on<K extends keyof GeoVideoEventMap>(
    event: K,
    handler: GeoVideoEventMap[K],
  ): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return this;
  }

  off<K extends keyof GeoVideoEventMap>(
    event: K,
    handler: GeoVideoEventMap[K],
  ): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  private initGl(gl: WebGL2RenderingContext): void {
    this.mercatorProgram = createProgram(gl, gridMercatorVert, geoVideoFrag);
    this.globeProgram = createProgram(gl, gridGlobeVert, geoVideoFrag);
    this.colorRampTexture = createColorRampTexture(
      gl,
      resolveColorRamp(this.colorRamp),
    );
    const vertices = new Float32Array(
      (GRID_LON_SEGMENTS + 1) * (GRID_LAT_SEGMENTS + 1) * 2,
    );
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
        indices[index++] = a;
        indices[index++] = c;
        indices[index++] = b;
        indices[index++] = b;
        indices[index++] = c;
        indices[index++] = d;
      }
    }
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    if (!this.vertexBuffer || !this.indexBuffer) {
      throw new Error("Failed to create GeoVideo grid");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexCount = indices.length;
  }

  private bindGrid(gl: WebGL2RenderingContext, program: WebGLProgram): void {
    const location = gl.getAttribLocation(program, "a_grid_uv");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
  }

  private unbindGrid(gl: WebGL2RenderingContext, program: WebGLProgram): void {
    gl.disableVertexAttribArray(gl.getAttribLocation(program, "a_grid_uv"));
  }

  private emit<K extends keyof GeoVideoEventMap>(
    event: K,
    ...args: Parameters<GeoVideoEventMap[K]>
  ): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as Function)(...args);
    }
  }
}
