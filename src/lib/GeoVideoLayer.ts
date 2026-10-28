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
  geoVideoNativeStepsPerSecond,
  geoVideoTimelineValues,
  loadGeoVideoManifest,
  type GeoVideoManifest,
  type GeoVideoScalarEncoding,
} from "./geovideo";
import type { FieldMeta } from "./types";
import type { ZartiglStatus } from "./load-status";

import { GeoVideoField } from "./GeoVideoField";
import { GeoVideoClock } from "./GeoVideoClock";
import { timeBracket } from "./time-bracket";

const GRID_LON_SEGMENTS = 128;
const GRID_LAT_SEGMENTS = 64;

function geoVideoTimelineBounds(manifest: GeoVideoManifest): [number, number] {
  const times = geoVideoTimelineValues(manifest);
  return [times[0], times[times.length - 1]];
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

interface GeoVideoStandby {
  field: GeoVideoField;
  time: number;
}

export class GeoVideoLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private readonly source: string | GeoVideoManifest;
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
  private gl: WebGL2RenderingContext | null = null;
  private manifest: GeoVideoManifest | null = null;
  private field: GeoVideoField | null = null;
  private pendingField: GeoVideoField | null = null;
  private standby: GeoVideoStandby | null = null;
  /** A preloaded chunk keeps playback active through the caller's handoff. */
  private awaitingNext = false;
  private readonly clock = new GeoVideoClock(false, (playing) => {
    this.emit("playbackChange", playing);
  });
  private lastTick: number | null = null;
  private lastStepTime: number | null = null;
  private seekId = 0;
  private seeking = false;
  private exactTime = 0;
  private endEmitted = false;
  private colorRampTexture: WebGLTexture | null = null;
  private mercatorProgram: WebGLProgram | null = null;
  private globeProgram: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCount = 0;
  private abortController: AbortController | null = null;
  private resumePlayback = false;
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
      if (this.abortController.signal.aborted) {
        return;
      }
      this.pendingField = this.createField(this.manifest);
      await this.prepare(this.pendingField);
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
    this.tick(performance.now());
    const field = this.field;
    if (!field) {
      return;
    }
    const manifest = field.manifest;
    const pair =
      this.pendingField || this.seeking
        ? field.currentPair
        : field.sample(
            this.clock.advancing ? this.clock.ms : this.exactTime,
            this.clock.advancing && !this.awaitingNext,
          );
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

  private tick(now: number): void {
    if (
      !this.field ||
      this.pendingField ||
      this.seeking ||
      this.awaitingNext ||
      !this.clock.advancing
    ) {
      this.lastTick = null;
      return;
    }
    const dt = this.lastTick === null ? 0 : (now - this.lastTick) / 1000;
    this.lastTick = now;
    const ended = this.clock.advance(
      dt,
      this.field.times,
      this.playbackRate * geoVideoNativeStepsPerSecond(this.field.manifest),
      this.playbackRange(this.field),
      this.loop,
      true,
    );
    const { index } = timeBracket(this.field.times, this.clock.ms);
    const time =
      this.field.manifest.timeline.kind === "snapshot-loop"
        ? this.field.times[0]
        : clampTime(this.timeRange!, this.field.times[index]);
    if (time !== this.lastStepTime) {
      this.lastStepTime = time;
      this.emit("timeChange", time);
    }
    if (ended) {
      this.reachEnd();
    } else {
      this.map?.triggerRepaint();
    }
  }

  onRemove(): void {
    this.abortController?.abort();
    this.seekId++;
    this.pendingField?.destroy();
    this.pendingField = null;
    this.discardStandby();
    this.field?.destroy();
    this.field = null;
    this.awaitingNext = false;
    this.seeking = false;
    this.lastTick = null;
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
    const requested = typeof time === "number" ? time : Date.parse(time);
    if (!Number.isFinite(requested)) {
      return;
    }
    this.requestedTime = requested;
    const field = this.pendingField ?? this.field;
    if (!field) {
      return;
    }
    void this.prepare(field).catch((error: unknown) => this.reportError(error));
  }

  /** Load the requested step first; stale seeks and swaps cannot replace it. */
  private async prepare(
    field: GeoVideoField,
    exactTime?: number,
  ): Promise<void> {
    const id = ++this.seekId;
    const range = this.timeRange ?? geoVideoTimelineBounds(field.manifest);
    const time = exactTime ?? clampTime(range, this.requestedTime ?? range[0]);
    const bracket = timeBracket(field.times, time);
    const index = Math.min(
      field.times.length - 1,
      bracket.index + (bracket.fraction > 0.5 ? 1 : 0),
    );
    const target = field.times[index];
    this.seeking = true;
    this.lastTick = null;
    field.focus(target);
    try {
      await field.prime(target);
    } catch (error) {
      if (id !== this.seekId) {
        return;
      }
      throw error;
    }
    if (id !== this.seekId || !this.map) {
      return;
    }
    const replacing = this.pendingField === field;
    if (replacing) {
      this.field?.destroy();
      this.field = field;
      this.pendingField = null;
      this.lastStepTime = null;
    }
    this.exactTime = target;
    this.clock.ms = clampTime(this.playbackRange(field), target);
    // Sampling the exact step also gives a paused seek a zero mix.
    field.sample(target, false);
    this.seeking = false;
    this.endEmitted = false;
    this.map.triggerRepaint();
    if (replacing) {
      const manifest = field.manifest;
      this.emit("loaded", {
        min: manifest.style.colorDomain[0],
        max: manifest.style.colorDomain[1],
        unit: manifest.style.unit ?? "",
        time: new Date(this.clock.ms).toISOString(),
      });
      this.emit("status", { phase: "ready", time: this.clock.ms });
      if (this.playOnReady) {
        this.playOnReady = false;
        const alreadyPlaying = this.clock.playing;
        await this.play();
        // The facade preloads the following chunk on this ready-to-play signal.
        if (alreadyPlaying) {
          this.emit("playbackChange", true);
        }
      }
    }
  }

  /** Keep the outgoing pair until the incoming chunk's requested step is ready. */
  replaceManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoReplaceOptions = {},
  ): boolean {
    const timeRange = this.replacementTimeRange(manifest, options);
    if (!timeRange || !this.gl) {
      return false;
    }
    this.playOnReady ||= this.isPlaying();
    this.pendingField?.destroy();
    const standby = this.standby;
    this.standby = null;
    if (standby && standby.field.manifest.media.url !== manifest.media.url) {
      standby.field.destroy();
    }
    this.pendingField =
      standby?.field.manifest.media.url === manifest.media.url
        ? standby.field
        : this.createField(manifest);
    this.awaitingNext = false;
    this.manifest = manifest;
    this.requestedTimeRange = options.timeRange;
    this.timeRange = timeRange;
    this.requestedTime = options.time ?? timeRange[0];
    this.loop = options.loop ?? this.loop;
    this.playbackRate = options.playbackRate ?? this.playbackRate;
    this.lastTick = null;
    void this.prepare(this.pendingField).catch((error: unknown) =>
      this.reportError(error),
    );
    return true;
  }

  /** Decode the next chunk ahead of its swap, including its static mask. */
  preloadManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoReplaceOptions = {},
  ): boolean {
    const range = this.replacementTimeRange(manifest, options);
    if (!range || !this.gl || manifest.media.url === this.manifest?.media.url) {
      return false;
    }
    const time = clampTime(range, options.time ?? range[0]);
    if (this.standby?.field.manifest.media.url !== manifest.media.url) {
      this.discardStandby();
      this.standby = { field: this.createField(manifest), time };
    }
    const standby = this.standby!;
    standby.time = time;
    void standby.field.prime(time).catch(() => {
      if (this.standby === standby) {
        this.discardStandby();
      }
    });
    return true;
  }

  private discardStandby(): void {
    this.standby?.field.destroy();
    this.standby = null;
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

  setTimeAndDepth(time: string | number, _depth: number): void {
    this.setTime(time);
  }
  setDepth(_depth: number): void {}
  async prefetchTime(ms: number): Promise<void> {
    await this.field?.prime(ms);
  }
  isFrameCached(ms: number): boolean {
    return this.field?.ready(ms) ?? false;
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
    if (!this.field || this.pendingField || this.awaitingNext) {
      this.playOnReady = true;
      return;
    }
    const ended = this.endEmitted;
    this.endEmitted = false;
    const range = this.playbackRange(this.field);
    if (ended) {
      this.setTime(range[0]);
    }
    this.lastTick = null;
    this.clock.setPlaying(true);
    this.map?.triggerRepaint();
  }

  pause(): void {
    const wasDeferred = this.playOnReady && !this.clock.playing;
    this.playOnReady = false;
    this.awaitingNext = false;
    this.clock.setPlaying(false);
    if (this.field && !this.pendingField && !this.seeking && !this.endEmitted) {
      const { index } = timeBracket(this.field.times, this.clock.ms);
      void this.prepare(this.field, this.field.times[index]).catch(
        (error: unknown) => this.reportError(error),
      );
    }
    if (wasDeferred) {
      this.emit("playbackChange", false);
    }
    this.lastTick = null;
    this.map?.triggerRepaint();
  }

  private isPlaying(): boolean {
    return this.clock.playing || this.playOnReady;
  }

  private reachEnd(): void {
    if (this.endEmitted) {
      return;
    }
    this.endEmitted = true;
    this.exactTime = this.clock.ms;
    this.lastTick = null;
    if (this.standby) {
      this.awaitingNext = true;
      this.playOnReady = true;
    } else {
      this.clock.setPlaying(false);
    }
    this.emit("playbackEnd");
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("GeoVideo playback rate must be positive");
    }
    this.playbackRate = rate;
  }

  setTimeRange(range: [number, number]): void {
    if (
      !Number.isFinite(range[0]) ||
      !Number.isFinite(range[1]) ||
      range[0] > range[1]
    ) {
      throw new Error("Invalid GeoVideo time range");
    }
    const clamped = clampTimeRange(
      this.manifest ? geoVideoTimelineBounds(this.manifest) : range,
      range,
    );
    if (clamped[0] > clamped[1]) {
      throw new Error(
        "GeoVideo time range does not overlap the manifest timeline",
      );
    }
    this.requestedTimeRange = range;
    this.timeRange = clamped;
    this.setTime(
      this.pendingField ? (this.requestedTime ?? clamped[0]) : this.clock.ms,
    );
  }

  getManifest(): GeoVideoManifest | null {
    return this.manifest;
  }

  getDebugInfo(): GeoVideoLayerDebugInfo {
    const field = this.field;
    return {
      kind: "scalar-geovideo",
      id: this.id,
      initialized: !!field?.currentPair,
      playing: this.isPlaying(),
      currentTime: field
        ? field.manifest.timeline.kind === "snapshot-loop"
          ? (this.clock.ms - field.times[0]) / 1000
          : geoVideoSecondsForTime(field.manifest, this.clock.ms)
        : 0,
      manifestId: this.manifest?.id,
      mediaUrl: this.manifest?.media.url,
      preloadedMediaUrl: this.standby?.field.manifest.media.url,
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

  private playbackRange(field: GeoVideoField): [number, number] {
    return field.manifest.timeline.kind === "snapshot-loop"
      ? [field.times[0], field.times[field.times.length - 1]]
      : (this.timeRange ?? [
          field.times[0],
          field.times[field.times.length - 1],
        ]);
  }

  private createField(manifest: GeoVideoManifest): GeoVideoField {
    return new GeoVideoField(this.gl!, manifest, {
      repeatLongitude: false,
      animateSnapshot: true,
      onError: (error) => this.reportError(error),
      onReady: () => this.map?.triggerRepaint(),
    });
  }

  private reportError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.name === "AbortError" || !this.map) {
      return;
    }
    this.emit("status", { phase: "error", error: err });
    this.emit("error", err);
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
