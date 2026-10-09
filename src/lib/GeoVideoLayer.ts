import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";
import {
  createColorRampTexture,
  createProgram,
  resolveColorRamp,
  restoreGLState,
  saveGLState,
  type ColorRampInput,
} from "./gl-util";
import { visibleWorldCopyOffsets } from "./geo-util";
import gridMercatorVert from "./shaders/grid_mercator.vert.glsl";
import gridGlobeVert from "./shaders/grid_globe.vert.glsl";
import geoVideoFrag from "./shaders/geovideo.frag.glsl";
import {
  geoVideoSecondsForTime,
  geoVideoTimeForSeconds,
  loadGeoVideoManifest,
  type GeoVideoManifest,
  type GeoVideoScalarEncoding,
} from "./geovideo";
import type { FieldMeta } from "./types";
import type { ZartiglStatus } from "./load-status";

const GRID_LON_SEGMENTS = 128;
/** Media playback rates browsers accept; slower speeds step through samples. */
const MIN_MEDIA_RATE = 1 / 16;
const MAX_MEDIA_RATE = 16;
const GRID_LAT_SEGMENTS = 64;

function clampMediaRate(rate: number): number {
  return Math.max(MIN_MEDIA_RATE, Math.min(MAX_MEDIA_RATE, rate));
}

function geoVideoTimelineBounds(manifest: GeoVideoManifest): [number, number] {
  if (manifest.timeline.kind === "snapshot-loop") {
    const time = new Date(manifest.timeline.date).getTime();
    return [time, time];
  }
  if (manifest.timeline.kind === "sample-sequence") {
    const values = manifest.timeline.values;
    return [
      new Date(values[0]).getTime(),
      new Date(values[values.length - 1]).getTime(),
    ];
  }
  return [
    new Date(manifest.timeline.dateStart).getTime(),
    new Date(manifest.timeline.dateEnd).getTime(),
  ];
}

function clampTimeRange(
  timeline: [number, number],
  requested?: [number, number],
): [number, number] {
  return requested
    ? [Math.max(timeline[0], requested[0]), Math.min(timeline[1], requested[1])]
    : timeline;
}

function clampTime([min, max]: [number, number], time: number): number {
  return Math.max(min, Math.min(max, time));
}

function geoVideoEndSecondsForTime(
  manifest: GeoVideoManifest,
  time: number,
): number {
  if (manifest.timeline.kind !== "sample-sequence") {
    return geoVideoSecondsForTime(manifest, time);
  }
  const values = manifest.timeline.values.map((value) =>
    new Date(value).getTime(),
  );
  let nearest = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index] - time) < Math.abs(values[nearest] - time)) {
      nearest = index;
    }
  }
  const segment = manifest.media.durationSeconds / values.length;
  return Math.max(0, (nearest + 1) * segment - 0.5 / manifest.media.fps);
}

type GeoVideoEventMap = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (error: Error) => void;
  status: (status: ZartiglStatus) => void;
  timeChange: (time: number) => void;
  playbackChange: (playing: boolean) => void;
  /** Playback reached the end of the timeline without looping. */
  playbackEnd: () => void;
};

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
export interface GeoVideoReplaceOptions {
  time?: number;
  timeRange?: [number, number];
  loop?: boolean;
  playbackRate?: number;
}

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

/** Artifact loaded ahead of its swap, opened at its start time. */
interface GeoVideoStandby {
  manifest: GeoVideoManifest;
  video: VideoWithFrameCallback;
  /** Mask image, when it differs from the one shown at preload time. */
  mask: HTMLImageElement | null;
  time: number;
}

export class GeoVideoLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private readonly source: string | GeoVideoManifest;
  /** Start playback once ready: autoplay, or a swap that was playing. */
  private playOnReady: boolean;
  private loop: boolean;
  private playbackRate: number;
  private requestedTime: number | null;
  private requestedTimeRange?: [number, number];
  private timeRange: [number, number] | null = null;
  private opacity: number;
  private colorRamp: ColorRampInput;
  private colorDomain: [number, number] | null;
  private logScale: boolean;
  private vibrance: number;
  private map: MaplibreMap | null = null;
  private gl: WebGLRenderingContext | null = null;
  private manifest: GeoVideoManifest | null = null;
  private video: VideoWithFrameCallback | null = null;
  /** Manifest of `video`, which still differs from `manifest` mid-swap. */
  private videoManifest: GeoVideoManifest | null = null;
  /** Incoming media of a swap, shown once its first frame is decodable. */
  private pendingVideo: VideoWithFrameCallback | null = null;
  private standby: GeoVideoStandby | null = null;
  /** Ended on a preloaded artifact: playing until it is swapped in or paused. */
  private awaitingNext = false;
  private maskUrl: string | null = null;
  private colorTexture: WebGLTexture | null = null;
  private maskTexture: WebGLTexture | null = null;
  private colorRampTexture: WebGLTexture | null = null;
  private maskCanvas: HTMLCanvasElement | null = null;
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
  private mediaReady = false;
  private readyEmitted = false;
  private hasVideoFrameCallback = false;
  private lastBufferedMediaTime = -1;
  private lastUploadedMediaTime = -1;
  private decodedFrames = 0;
  private frameCallbackCount = 0;
  private frameCallbackTimes: number[] = [];
  private lastFrameCallbackAt = -1;
  private bufferedFrames = 0;
  private skippedFrames = 0;
  private uploadedFrames = 0;
  private lastUploadDurationMs = 0;
  private abortController: AbortController | null = null;
  private resumePlayback = false;
  private stepTimer: ReturnType<typeof setInterval> | null = null;
  private endEmitted = false;
  private listeners = new Map<keyof GeoVideoEventMap, Set<Function>>();

  constructor(options: GeoVideoLayerOptions) {
    this.id = options.id;
    this.source = options.manifest;
    this.opacity = options.opacity ?? 1;
    this.playOnReady = options.autoplay ?? true;
    this.loop = options.loop ?? true;
    this.playbackRate = options.playbackRate ?? 1;
    const requestedTime =
      options.time == null
        ? NaN
        : typeof options.time === "number"
          ? options.time
          : new Date(options.time).getTime();
    this.requestedTime = Number.isFinite(requestedTime) ? requestedTime : null;
    this.requestedTimeRange = options.timeRange;
    this.colorRamp = options.colorRamp ?? "balance";
    this.colorDomain = options.colorDomain ?? null;
    this.logScale = options.logScale ?? false;
    this.vibrance = options.vibrance ?? 0;
  }

  async onAdd(map: MaplibreMap, gl: WebGLRenderingContext): Promise<void> {
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
      if (this.manifest.encoding.kind !== "scalar-luma") {
        throw new Error(
          `GeoVideoLayer renders scalar-luma manifests, received ${this.manifest.encoding.kind}`,
        );
      }
      this.timeRange = clampTimeRange(
        geoVideoTimelineBounds(this.manifest),
        this.requestedTimeRange,
      );
      if (this.timeRange[0] > this.timeRange[1]) {
        throw new Error(
          "GeoVideo time range does not overlap the manifest timeline",
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
      this.initVideo(this.manifest);
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

  render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
    // Decode the texture with the manifest of the media it was uploaded from.
    const manifest = this.videoManifest;
    const video = this.video;
    if (!manifest || !video || !this.colorTexture || !this.maskTexture) {
      return;
    }
    if (
      !this.hasVideoFrameCallback &&
      video.currentTime !== this.lastBufferedMediaTime
    ) {
      this.bufferFrame(video.currentTime);
    }
    const saved = saveGLState(gl);
    gl.activeTexture(gl.TEXTURE0);
    const previousTexture0 = gl.getParameter(
      gl.TEXTURE_BINDING_2D,
    ) as WebGLTexture | null;
    gl.activeTexture(gl.TEXTURE1);
    const previousTexture1 = gl.getParameter(
      gl.TEXTURE_BINDING_2D,
    ) as WebGLTexture | null;
    gl.activeTexture(gl.TEXTURE2);
    const previousTexture2 = gl.getParameter(
      gl.TEXTURE_BINDING_2D,
    ) as WebGLTexture | null;
    try {
      if (this.maskDirty && this.maskCanvas) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
        try {
          this.uploadTextureSource(
            gl,
            this.maskCanvas,
            this.maskTextureInitialized,
          );
          this.maskTextureInitialized = true;
          this.maskDirty = false;
        } catch {
          this.skippedFrames += 1;
          return;
        }
      }
      // Mid-seek or stalled media has no frame to show: keep the last one.
      if (
        this.frameDirty &&
        !video.seeking &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        const uploadStarted = performance.now();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
        try {
          this.uploadTextureSource(gl, video, this.colorTextureInitialized);
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
      if (!this.colorTextureInitialized || !this.maskTextureInitialized) {
        return;
      }
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
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
      gl.uniform1i(gl.getUniformLocation(program, "u_color"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
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
      const encoding = manifest.encoding as GeoVideoScalarEncoding;
      const codeMin = encoding.codeMin / 255;
      const codeMax = encoding.codeMax / 255;
      const valueMin = encoding.valueMin;
      const valueMax = encoding.valueMax;
      const domain = this.colorDomain ?? [valueMin, valueMax];
      gl.uniform2f(
        gl.getUniformLocation(program, "u_code_range"),
        codeMin,
        codeMax,
      );
      gl.uniform2f(
        gl.getUniformLocation(program, "u_value_range"),
        valueMin,
        valueMax,
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
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture2);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture0);
      restoreGLState(gl, saved);
    }
  }

  onRemove(): void {
    this.stopStepping(false);
    this.abortController?.abort();
    this.abortController = null;
    this.discardPendingVideo();
    this.discardStandby();
    this.awaitingNext = false;
    this.releaseVideo();
    this.stopRepaintLoop();
    if (this.gl) {
      if (this.colorTexture) {
        this.gl.deleteTexture(this.colorTexture);
      }
      if (this.maskTexture) {
        this.gl.deleteTexture(this.maskTexture);
      }
      if (this.colorRampTexture) {
        this.gl.deleteTexture(this.colorRampTexture);
      }
      if (this.mercatorProgram) {
        this.gl.deleteProgram(this.mercatorProgram);
      }
      if (this.globeProgram) {
        this.gl.deleteProgram(this.globeProgram);
      }
      if (this.vertexBuffer) {
        this.gl.deleteBuffer(this.vertexBuffer);
      }
      if (this.indexBuffer) {
        this.gl.deleteBuffer(this.indexBuffer);
      }
    }
    this.video = null;
    this.videoManifest = null;
    this.maskUrl = null;
    this.colorTexture = null;
    this.maskTexture = null;
    this.colorRampTexture = null;
    this.maskCanvas = null;
    this.maskContext = null;
    this.colorTextureInitialized = false;
    this.maskTextureInitialized = false;
    this.maskCaptured = false;
    this.mediaReady = false;
    this.readyEmitted = false;
    this.hasVideoFrameCallback = false;
    this.lastBufferedMediaTime = -1;
    this.lastUploadedMediaTime = -1;
    this.decodedFrames = 0;
    this.frameCallbackCount = 0;
    this.frameCallbackTimes = [];
    this.lastFrameCallbackAt = -1;
    this.bufferedFrames = 0;
    this.skippedFrames = 0;
    this.uploadedFrames = 0;
    this.lastUploadDurationMs = 0;
    this.mercatorProgram = null;
    this.globeProgram = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.map = null;
    this.gl = null;
  }

  setTime(time: string | number): void {
    const requested =
      typeof time === "number" ? time : new Date(time).getTime();
    if (!Number.isFinite(requested)) {
      return;
    }
    this.requestedTime = requested;
    const video = this.pendingVideo ?? this.video;
    if (!video || !this.manifest) {
      return;
    }
    const [min, max] = this.timeRange ?? geoVideoTimelineBounds(this.manifest);
    const ms = Math.max(min, Math.min(max, requested));
    const seconds = geoVideoSecondsForTime(this.manifest, ms);
    // Already there: skip the seek. Safari drops the last frames of media
    // seeked while it starts playing, as after an archive chunk swap.
    if (Math.abs(video.currentTime - seconds) > 0.5 / this.manifest.media.fps) {
      video.currentTime = seconds;
    }
    this.map?.triggerRepaint();
  }

  /**
   * Switch to another artifact of the same frame size, such as the next
   * archive chunk, keeping the map layer and GL state. The current frame stays
   * on screen until the new media can show its first one, at once when it was
   * preloaded. Returns false when the artifact needs a new layer.
   */
  replaceManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoReplaceOptions = {},
  ): boolean {
    const timeRange = this.replacementTimeRange(manifest, options);
    if (!timeRange || !this.video) {
      return false;
    }
    const standby = this.takeStandby(manifest);
    if (this.pendingVideo) {
      this.discardPendingVideo();
    } else {
      // Freeze the outgoing media on its last frame without reporting a pause.
      // Keep an autoplay that has not started yet, or a handoff at its end.
      this.playOnReady ||= this.isPlaying();
      this.stopStepping(false);
      this.stopRepaintLoop();
      this.cancelFrameCallback();
    }
    this.awaitingNext = false;
    this.manifest = manifest;
    this.requestedTimeRange = options.timeRange;
    this.timeRange = timeRange;
    this.requestedTime = options.time ?? null;
    this.loop = options.loop ?? this.loop;
    this.playbackRate = options.playbackRate ?? this.playbackRate;
    // Applied with the first frame, so mask and values stay in step.
    const mask =
      manifest.mask.url === this.maskUrl
        ? null
        : (standby?.mask ?? this.createMaskImage(manifest));
    const video = standby?.video ?? this.createVideo(manifest);
    this.pendingVideo = video;
    this.video.pause();
    const commit = () => {
      if (
        video !== this.pendingVideo ||
        video.seeking ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }
      if (!this.checkVideoSize(video, manifest)) {
        this.discardPendingVideo();
        return;
      }
      this.pendingVideo = null;
      this.releaseVideo();
      this.video = video;
      this.videoManifest = manifest;
      this.endEmitted = false;
      video.defaultPlaybackRate = clampMediaRate(this.playbackRate);
      video.playbackRate = video.defaultPlaybackRate;
      if (mask) {
        this.applyMask(manifest, mask);
      }
      this.startFrameCallbacks(video, manifest);
      this.bufferFrame(video.currentTime);
      this.mediaReady = true;
      this.readyEmitted = false;
      this.emitReady();
    };
    video.addEventListener("loadeddata", commit);
    video.addEventListener("seeked", commit);
    if (!standby) {
      video.load();
    } else if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      // Preloaded at its start: seek only when the swap asks for another time.
      const seconds = geoVideoSecondsForTime(
        manifest,
        this.startTime(video, manifest),
      );
      if (Math.abs(video.currentTime - seconds) > 0.5 / manifest.media.fps) {
        video.currentTime = seconds;
      }
      commit();
    }
    return true;
  }

  /**
   * Load the artifact expected next, such as the following archive chunk, so
   * `replaceManifest` can show it without waiting for the network. Until then,
   * reaching the end of the current artifact keeps the playing state and
   * emits `playbackEnd` for the caller to swap it in, or to pause. Returns
   * false when the artifact cannot replace the current one in place.
   */
  preloadManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoReplaceOptions = {},
  ): boolean {
    const timeRange = this.replacementTimeRange(manifest, options);
    if (!timeRange || manifest.media.url === this.manifest?.media.url) {
      return false;
    }
    const time = clampTime(timeRange, options.time ?? timeRange[0]);
    if (this.standby?.manifest.media.url === manifest.media.url) {
      this.standby.time = time;
      return true;
    }
    this.discardStandby();
    const video = this.createVideo(manifest);
    this.standby = {
      manifest,
      video,
      mask:
        manifest.mask.url === this.maskUrl
          ? null
          : this.createMaskImage(manifest),
      time,
    };
    video.load();
    return true;
  }

  /** Clamped time range of a compatible replacement, else null. */
  private replacementTimeRange(
    manifest: GeoVideoManifest,
    options: GeoVideoReplaceOptions,
  ): [number, number] | null {
    const current = this.manifest;
    if (
      !current ||
      manifest.encoding.kind !== "scalar-luma" ||
      manifest.media.width !== current.media.width ||
      manifest.media.height !== current.media.height ||
      manifest.mask.width !== current.mask.width ||
      manifest.mask.height !== current.mask.height
    ) {
      return null;
    }
    const timeRange = clampTimeRange(
      geoVideoTimelineBounds(manifest),
      options.timeRange,
    );
    return timeRange[0] <= timeRange[1] ? timeRange : null;
  }

  /** The preloaded artifact when it holds this media; any other is dropped. */
  private takeStandby(manifest: GeoVideoManifest): GeoVideoStandby | null {
    const standby = this.standby;
    if (standby?.manifest.media.url !== manifest.media.url) {
      this.discardStandby();
      return null;
    }
    this.standby = null;
    return standby;
  }

  setTimeAndDepth(time: string | number, _depth: number): void {
    this.setTime(time);
  }
  setDepth(_depth: number): void {}
  async prefetchTime(_ms: number): Promise<void> {}
  isFrameCached(_ms: number): boolean {
    return true;
  }
  cancelPrefetches(): void {}
  suspend(): void {
    this.resumePlayback = this.isPlaying();
    this.pause();
  }
  resume(): void {
    if (this.resumePlayback) {
      void this.play();
    }
    this.resumePlayback = false;
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
    if (this.deferredPlayback()) {
      this.playOnReady = true;
      return;
    }
    if (!this.video || !this.manifest) {
      return;
    }
    this.endEmitted = false;
    const [, max] = this.timeRange ?? geoVideoTimelineBounds(this.manifest);
    if (
      this.video.currentTime >= geoVideoEndSecondsForTime(this.manifest, max)
    ) {
      this.setTime(
        (this.timeRange ?? geoVideoTimelineBounds(this.manifest))[0],
      );
    }
    if (this.playbackRate < MIN_MEDIA_RATE) {
      this.startStepping();
      return;
    }
    await this.video.play();
  }

  pause(): void {
    if (this.deferredPlayback()) {
      const playing = this.playOnReady;
      this.playOnReady = false;
      this.awaitingNext = false;
      if (playing) {
        this.emit("playbackChange", false);
      }
      return;
    }
    this.stopStepping(true);
    this.video?.pause();
  }

  /**
   * Playback is a request, applied once ready, while the manifest loads,
   * mid-swap, or at an end waiting for the preloaded artifact.
   */
  private deferredPlayback(): boolean {
    return this.video == null || this.pendingVideo != null || this.awaitingNext;
  }

  private isPlaying(): boolean {
    if (this.deferredPlayback()) {
      return this.playOnReady;
    }
    return this.stepTimer != null || (this.video != null && !this.video.paused);
  }

  /**
   * Below the slowest media rate browsers accept, keep the video paused and
   * seek one sample (or frame) at a time.
   */
  private startStepping(): void {
    const manifest = this.manifest;
    if (!manifest || !this.video) {
      return;
    }
    this.stopStepping(false);
    this.video.pause();
    const stepSeconds =
      manifest.timeline.kind === "sample-sequence"
        ? manifest.media.durationSeconds / manifest.timeline.values.length
        : 1 / manifest.media.fps;
    this.stepTimer = setInterval(
      () => this.step(manifest, stepSeconds),
      Math.max(16, (stepSeconds / this.playbackRate) * 1000),
    );
    this.emit("playbackChange", true);
  }

  private stopStepping(notify: boolean): void {
    if (this.stepTimer == null) {
      return;
    }
    clearInterval(this.stepTimer);
    this.stepTimer = null;
    if (notify) {
      this.emit("playbackChange", false);
    }
  }

  private step(manifest: GeoVideoManifest, stepSeconds: number): void {
    const video = this.video;
    if (!video) {
      return;
    }
    const [min, max] = this.timeRange ?? geoVideoTimelineBounds(manifest);
    let next = video.currentTime + stepSeconds;
    if (next > geoVideoEndSecondsForTime(manifest, max)) {
      if (!this.loop) {
        this.stopStepping(false);
        this.reachEnd(true);
        return;
      }
      next = geoVideoSecondsForTime(manifest, min);
    }
    video.currentTime = next;
    this.emit("timeChange", geoVideoTimeForSeconds(manifest, next));
    this.map?.triggerRepaint();
  }

  /**
   * The timeline ended without looping. With a preloaded artifact, keep the
   * playing state for the caller to swap it in; otherwise stop.
   */
  private reachEnd(notifyPause: boolean): void {
    if (this.standby) {
      this.awaitingNext = true;
      this.playOnReady = true;
    } else if (notifyPause) {
      this.emit("playbackChange", false);
    }
    if (!this.endEmitted) {
      this.endEmitted = true;
      this.emit("playbackEnd");
    }
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    const video = this.pendingVideo ?? this.video;
    if (video && this.manifest?.timeline.kind === "snapshot-loop") {
      video.loop = loop;
    }
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("GeoVideo playback rate must be positive");
    }
    const stepping = this.stepTimer != null;
    const playing = this.isPlaying();
    this.playbackRate = rate;
    const video = this.pendingVideo ?? this.video;
    if (video) {
      video.defaultPlaybackRate = clampMediaRate(rate);
      video.playbackRate = video.defaultPlaybackRate;
    }
    if (playing && stepping !== rate < MIN_MEDIA_RATE) {
      this.stopStepping(false);
      void this.play();
    } else if (stepping) {
      this.startStepping();
    }
  }

  setTimeRange(range: [number, number]): void {
    if (
      !Number.isFinite(range[0]) ||
      !Number.isFinite(range[1]) ||
      range[0] > range[1]
    ) {
      throw new Error("Invalid GeoVideo time range");
    }
    this.requestedTimeRange = range;
    this.timeRange = clampTimeRange(
      this.manifest ? geoVideoTimelineBounds(this.manifest) : range,
      range,
    );
    if (this.video && this.manifest) {
      // Mid-swap, the incoming media may not have reached its target yet.
      const current =
        this.pendingVideo && this.requestedTime != null
          ? this.requestedTime
          : geoVideoTimeForSeconds(
              this.manifest,
              (this.pendingVideo ?? this.video).currentTime,
            );
      this.setTime(current);
    }
  }

  getManifest(): GeoVideoManifest | null {
    return this.manifest;
  }

  getDebugInfo(): GeoVideoLayerDebugInfo {
    return {
      kind: "scalar-geovideo",
      id: this.id,
      initialized:
        this.manifest != null &&
        this.colorTexture != null &&
        this.maskTexture != null,
      playing: this.isPlaying(),
      currentTime: this.video?.currentTime ?? 0,
      manifestId: this.manifest?.id,
      mediaUrl: this.manifest?.media.url,
      preloadedMediaUrl: this.standby?.manifest.media.url,
      decodedFrames: this.decodedFrames,
      bufferedFrames: this.bufferedFrames,
      skippedFrames: this.skippedFrames,
      uploadedFrames: this.uploadedFrames,
      droppedFrames:
        this.video?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      lastUploadDurationMs: this.lastUploadDurationMs,
      frameCallbackCount: this.frameCallbackCount,
      presentedFps: this.presentedFps(),
      lastFrameAgeMs:
        this.lastFrameCallbackAt >= 0
          ? Math.max(0, performance.now() - this.lastFrameCallbackAt)
          : null,
      readyState: this.video?.readyState ?? 0,
      networkState: this.video?.networkState ?? 0,
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

  private initGl(gl: WebGLRenderingContext): void {
    this.mercatorProgram = createProgram(gl, gridMercatorVert, geoVideoFrag);
    this.globeProgram = createProgram(gl, gridGlobeVert, geoVideoFrag);
    this.colorTexture = this.createVideoTexture(gl, gl.LINEAR);
    this.maskTexture = this.createVideoTexture(gl, gl.NEAREST);
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

  private initVideo(manifest: GeoVideoManifest): void {
    this.maskCanvas = document.createElement("canvas");
    this.maskCanvas.width = manifest.media.width;
    this.maskCanvas.height = manifest.media.height;
    this.maskContext = this.maskCanvas.getContext("2d", { alpha: false });
    if (!this.maskContext) {
      throw new Error("Failed to create GeoVideo frame buffers");
    }
    this.applyMask(manifest, this.createMaskImage(manifest));
    const video = this.createVideo(manifest);
    video.addEventListener(
      "loadeddata",
      () => {
        if (!this.checkVideoSize(video, manifest)) {
          return;
        }
        this.bufferFrame(video.currentTime);
        this.mediaReady = true;
        this.emitReady();
      },
      { once: true },
    );
    this.video = video;
    this.videoManifest = manifest;
    this.startFrameCallbacks(video, manifest);
    video.load();
  }

  /**
   * Media element for a manifest. Its events drive the layer only while it is
   * the current video and no swap is pending.
   */
  private createVideo(manifest: GeoVideoManifest): VideoWithFrameCallback {
    const video = document.createElement("video") as VideoWithFrameCallback;
    const isCurrent = () => video === this.video && this.pendingVideo == null;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = manifest.timeline.kind === "snapshot-loop" && this.loop;
    // Loading media resets playbackRate to defaultPlaybackRate, so set both
    // and apply the rate again once metadata is known.
    video.defaultPlaybackRate = clampMediaRate(this.playbackRate);
    video.playbackRate = video.defaultPlaybackRate;
    video.playsInline = true;
    video.preload = "auto";
    video.src = manifest.media.url;
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.playbackRate = clampMediaRate(this.playbackRate);
        video.currentTime = geoVideoSecondsForTime(
          manifest,
          this.startTime(video, manifest),
        );
      },
      { once: true },
    );
    video.addEventListener("error", () => {
      // A failed preload is retried, and reported, by the swap itself.
      if (video === this.standby?.video) {
        this.discardStandby();
        return;
      }
      if (video !== this.video && video !== this.pendingVideo) {
        return;
      }
      if (video === this.pendingVideo) {
        this.discardPendingVideo();
      }
      const error = new Error(
        `Failed to load GeoVideo media: ${manifest.media.url}`,
      );
      this.emit("status", { phase: "error", error });
      this.emit("error", error);
    });
    video.addEventListener("playing", () => {
      if (!isCurrent()) {
        return;
      }
      if (!this.hasVideoFrameCallback) {
        this.startRepaintLoop();
      }
      this.emit("playbackChange", true);
    });
    video.addEventListener("pause", () => {
      if (!isCurrent()) {
        return;
      }
      this.stopRepaintLoop();
      // Stepped playback pauses the media on purpose, and the end of the
      // timeline reports its own state.
      if (this.stepTimer == null && !video.ended && !this.awaitingNext) {
        this.emit("playbackChange", false);
      }
    });
    video.addEventListener("waiting", () => {
      if (isCurrent()) {
        this.stopRepaintLoop();
      }
    });
    video.addEventListener("ended", () => {
      if (!isCurrent()) {
        return;
      }
      this.stopRepaintLoop();
      if (this.loop) {
        const [min] = this.timeRange ?? geoVideoTimelineBounds(manifest);
        video.currentTime = geoVideoSecondsForTime(manifest, min);
        void video.play().catch(() => this.emit("playbackChange", false));
        return;
      }
      this.reachEnd(true);
    });
    return video;
  }

  /** Track presented frames of the current video. */
  private startFrameCallbacks(
    video: VideoWithFrameCallback,
    manifest: GeoVideoManifest,
  ): void {
    const markFrame = (_now?: number, metadata?: VideoFrameMetadata) => {
      if (video !== this.video) {
        return;
      }
      this.decodedFrames = metadata?.presentedFrames ?? this.decodedFrames + 1;
      const callbackTime = _now ?? performance.now();
      this.frameCallbackCount += 1;
      this.lastFrameCallbackAt = callbackTime;
      this.frameCallbackTimes.push(callbackTime);
      while (this.frameCallbackTimes.length > 120) {
        this.frameCallbackTimes.shift();
      }
      const mediaTime = metadata?.mediaTime ?? video.currentTime;
      this.bufferFrame(mediaTime);
      const time = geoVideoTimeForSeconds(manifest, mediaTime);
      if (manifest.timeline.kind === "snapshot-loop") {
        this.emit("timeChange", time);
        this.map?.triggerRepaint();
        this.frameCallback =
          video.requestVideoFrameCallback?.(markFrame) ?? null;
        return;
      }
      const [min, max] = this.timeRange ?? geoVideoTimelineBounds(manifest);
      const reachedEnd =
        manifest.timeline.kind === "sample-sequence"
          ? mediaTime >= geoVideoEndSecondsForTime(manifest, max)
          : time >= max;
      if (reachedEnd) {
        this.emit("timeChange", max);
        if (this.loop && !video.paused) {
          video.currentTime = geoVideoSecondsForTime(manifest, min);
        } else if (!video.paused) {
          // Before the pause event, which then knows about a handoff.
          this.reachEnd(false);
          video.pause();
          video.currentTime = geoVideoSecondsForTime(manifest, max);
        }
      } else {
        this.emit("timeChange", Math.max(min, time));
      }
      this.map?.triggerRepaint();
      this.frameCallback = video.requestVideoFrameCallback?.(markFrame) ?? null;
    };
    this.hasVideoFrameCallback =
      typeof video.requestVideoFrameCallback === "function";
    if (this.hasVideoFrameCallback) {
      this.frameCallback = video.requestVideoFrameCallback!(markFrame);
    } else {
      video.addEventListener("timeupdate", () => markFrame());
    }
  }

  /**
   * Time a loading video opens at: its preload target, or the requested time
   * within the active range.
   */
  private startTime(
    video: HTMLVideoElement,
    manifest: GeoVideoManifest,
  ): number {
    if (video === this.standby?.video) {
      return this.standby.time;
    }
    const range = this.timeRange ?? geoVideoTimelineBounds(manifest);
    return clampTime(range, this.requestedTime ?? range[0]);
  }

  private checkVideoSize(
    video: HTMLVideoElement,
    manifest: GeoVideoManifest,
  ): boolean {
    if (
      video.videoWidth === manifest.media.width &&
      video.videoHeight === manifest.media.height
    ) {
      return true;
    }
    const error = new Error(
      `GeoVideo media dimensions ${video.videoWidth}x${video.videoHeight} do not match manifest ` +
        `${manifest.media.width}x${manifest.media.height}`,
    );
    this.emit("status", { phase: "error", error });
    this.emit("error", error);
    return false;
  }

  private cancelFrameCallback(): void {
    if (this.frameCallback != null) {
      this.video?.cancelVideoFrameCallback?.(this.frameCallback);
    }
    this.frameCallback = null;
  }

  /** Stop the current video and free its media resources. */
  private releaseVideo(): void {
    const video = this.video;
    if (!video) {
      return;
    }
    this.cancelFrameCallback();
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  private discardStandby(): void {
    const video = this.standby?.video;
    if (!video) {
      return;
    }
    this.standby = null;
    video.removeAttribute("src");
    video.load();
  }

  private discardPendingVideo(): void {
    const video = this.pendingVideo;
    if (!video) {
      return;
    }
    this.pendingVideo = null;
    video.removeAttribute("src");
    video.load();
  }

  private bufferFrame(mediaTime: number): boolean {
    const video = this.video;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return false;
    }
    this.lastBufferedMediaTime = mediaTime;
    this.frameDirty = true;
    this.bufferedFrames += 1;
    return true;
  }

  private createMaskImage(manifest: GeoVideoManifest): HTMLImageElement {
    const image = document.createElement("img");
    image.crossOrigin = "anonymous";
    image.src = manifest.mask.url;
    return image;
  }

  /** Show the mask of a manifest once its image, possibly preloaded, loads. */
  private applyMask(manifest: GeoVideoManifest, image: HTMLImageElement): void {
    this.maskUrl = manifest.mask.url;
    const draw = () => {
      if (
        !this.maskContext ||
        !this.maskCanvas ||
        this.abortController?.signal.aborted ||
        manifest.mask.url !== this.maskUrl
      ) {
        return;
      }
      if (
        image.naturalWidth !== manifest.mask.width ||
        image.naturalHeight !== manifest.mask.height
      ) {
        const error = new Error(
          `GeoVideo mask dimensions ${image.naturalWidth}x${image.naturalHeight} do not match manifest ` +
            `${manifest.mask.width}x${manifest.mask.height}`,
        );
        this.emit("status", { phase: "error", error });
        this.emit("error", error);
        return;
      }
      this.maskContext.drawImage(
        image,
        0,
        0,
        manifest.mask.width,
        manifest.mask.height,
      );
      this.maskCaptured = true;
      this.maskDirty = true;
      this.emitReady();
      this.map?.triggerRepaint();
    };
    const fail = () => {
      if (manifest.mask.url !== this.maskUrl) {
        return;
      }
      const error = new Error(
        `Failed to load GeoVideo mask: ${manifest.mask.url}`,
      );
      this.emit("status", { phase: "error", error });
      this.emit("error", error);
    };
    if (image.complete && image.naturalWidth > 0) {
      draw();
      return;
    }
    image.addEventListener("load", draw, { once: true });
    image.addEventListener("error", fail, { once: true });
  }

  private emitReady(): void {
    const manifest = this.manifest;
    const video = this.video;
    if (
      !manifest ||
      !video ||
      this.pendingVideo ||
      !this.mediaReady ||
      !this.maskCaptured ||
      this.readyEmitted
    ) {
      return;
    }
    this.readyEmitted = true;
    const time = geoVideoTimeForSeconds(manifest, video.currentTime);
    this.emit("loaded", {
      min: manifest.style.colorDomain[0],
      max: manifest.style.colorDomain[1],
      unit: manifest.style.unit ?? "",
      time: new Date(time).toISOString(),
    });
    this.emit("status", { phase: "ready", time });
    this.map?.triggerRepaint();
    if (this.playOnReady) {
      this.playOnReady = false;
      // Through play(), so speeds below the media minimum step frames.
      void this.play().catch(() => undefined);
    }
  }

  private createVideoTexture(
    gl: WebGLRenderingContext,
    filter: number,
  ): WebGLTexture {
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Failed to create GeoVideo texture");
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return texture;
  }

  private uploadTextureSource(
    gl: WebGLRenderingContext,
    source: HTMLCanvasElement | HTMLVideoElement,
    initialized: boolean,
  ): void {
    const unpackFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    try {
      if (initialized) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          source,
        );
      } else {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          source,
        );
      }
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, unpackFlipY ? 1 : 0);
    }
  }

  private startRepaintLoop(): void {
    if (this.repaintFrame != null || !this.map) {
      return;
    }
    const repaint = () => {
      this.repaintFrame = null;
      if (!this.map || !this.video || this.video.paused || this.video.ended) {
        return;
      }
      this.map.triggerRepaint();
      this.repaintFrame = requestAnimationFrame(repaint);
    };
    this.map.triggerRepaint();
    this.repaintFrame = requestAnimationFrame(repaint);
  }

  private stopRepaintLoop(): void {
    if (this.repaintFrame == null) {
      return;
    }
    cancelAnimationFrame(this.repaintFrame);
    this.repaintFrame = null;
  }

  private presentedFps(): number {
    if (this.frameCallbackTimes.length < 2) {
      return 0;
    }
    const now = performance.now();
    const recent = this.frameCallbackTimes.filter(
      (value) => now - value <= 2000,
    );
    if (recent.length < 2) {
      return 0;
    }
    const elapsed = recent[recent.length - 1] - recent[0];
    return elapsed > 0 ? ((recent.length - 1) * 1000) / elapsed : 0;
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

  private emit<K extends keyof GeoVideoEventMap>(
    event: K,
    ...args: Parameters<GeoVideoEventMap[K]>
  ): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as Function)(...args);
    }
  }
}
