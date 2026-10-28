import { GeoVideoField } from "./GeoVideoField";
import { GeoVideoClock } from "./GeoVideoClock";
import {
  geoVideoTimelineValues,
  geoVideoNativeStepsPerSecond,
  type GeoVideoManifest,
} from "./geovideo";
import { timeBracket } from "./time-bracket";
import type { FieldMeta } from "./types";
import type { ZartiglStatus } from "./load-status";

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

export type GeoVideoPlaybackEvents = {
  loading: () => void;
  loaded: (meta: FieldMeta) => void;
  error: (error: Error) => void;
  status: (status: ZartiglStatus) => void;
  timeChange: (time: number) => void;
  playbackChange: (playing: boolean) => void;
  /** Playback reached the end of the timeline without looping. */
  playbackEnd: () => void;
};

export interface GeoVideoPlaybackReplaceOptions {
  time?: number;
  stepsPerSecond?: number;
  timeRange?: [number, number];
  loop?: boolean;
  playbackRate?: number;
}

export interface GeoVideoPlaybackOptions {
  time?: string | number;
  timeRange?: [number, number];
  autoplay?: boolean;
  loop?: boolean;
  playbackRate?: number;
  stepsPerSecond?: number;
}

/** Render-driven GeoVideo playback and chunk handoff, shared by both MapLibre adapters. */
export class GeoVideoPlayback {
  field: GeoVideoField | null = null;
  manifest: GeoVideoManifest | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private pendingField: GeoVideoField | null = null;
  private standby: { field: GeoVideoField; time: number } | null = null;
  private awaitingNext = false;
  private playOnReady: boolean;
  private loop: boolean;
  private playbackRate: number;
  private stepsPerSecond?: number;
  private requestedTime: number | null;
  private requestedTimeRange?: [number, number];
  private timeRange: [number, number] | null = null;
  private lastTick: number | null = null;
  private lastStepTime: number | null = null;
  private seekId = 0;
  private seeking = false;
  private failed = false;
  private exactTime = 0;
  private endEmitted = false;
  private destroyed = false;
  private resumePlayback = false;
  private readonly clock: GeoVideoClock;

  constructor(
    options: GeoVideoPlaybackOptions,
    private readonly repaint: () => void,
    private readonly emit: <K extends keyof GeoVideoPlaybackEvents>(
      event: K,
      ...args: Parameters<GeoVideoPlaybackEvents[K]>
    ) => void,
  ) {
    this.playOnReady = options.autoplay ?? true;
    this.loop = options.loop ?? true;
    this.playbackRate = options.playbackRate ?? 1;
    this.stepsPerSecond = options.stepsPerSecond;
    const time =
      typeof options.time === "string"
        ? Date.parse(options.time)
        : options.time;
    this.requestedTime = time != null && Number.isFinite(time) ? time : null;
    this.requestedTimeRange = options.timeRange;
    this.clock = new GeoVideoClock(false, (playing) =>
      this.emit("playbackChange", playing),
    );
  }

  async load(
    gl: WebGL2RenderingContext,
    manifest: GeoVideoManifest,
  ): Promise<void> {
    this.gl = gl;
    this.manifest = manifest;
    this.timeRange = clampTimeRange(
      geoVideoTimelineBounds(manifest),
      this.requestedTimeRange,
    );
    if (this.timeRange[0] > this.timeRange[1]) {
      throw new Error(
        "GeoVideo time range does not overlap the manifest timeline",
      );
    }
    this.pendingField = this.createField(manifest);
    await this.prepare(this.pendingField);
  }

  sample(now: number): readonly [WebGLTexture, WebGLTexture, number] | null {
    this.tick(now);
    if (!this.field) {
      return null;
    }
    return this.pendingField || this.seeking
      ? this.field.currentPair
      : this.field.sample(
          this.clock.advancing ? this.clock.ms : this.exactTime,
          this.clock.advancing && !this.awaitingNext,
        );
  }

  get time(): number {
    return this.clock.ms;
  }
  get preloadedMediaUrl(): string | undefined {
    return this.standby?.field.manifest.media.url;
  }

  setStepsPerSecond(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("GeoVideo steps per second must be positive");
    }
    this.stepsPerSecond = value;
  }

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

  destroy(): void {
    this.destroyed = true;
    this.seekId++;
    this.pendingField?.destroy();
    this.pendingField = null;
    this.discardStandby();
    this.field?.destroy();
    this.field = null;
    this.gl = null;
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
      this.stepsPerSecond ??
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
      this.repaint();
    }
  }

  setTime(time: string | number): void {
    const requested = typeof time === "number" ? time : Date.parse(time);
    if (!Number.isFinite(requested)) {
      return;
    }
    this.requestedTime = requested;
    this.awaitingNext = false;
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
    this.failed = false;
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
    if (id !== this.seekId || this.destroyed) {
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
    this.repaint();
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
    options: GeoVideoPlaybackReplaceOptions = {},
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
    this.stepsPerSecond = options.stepsPerSecond ?? this.stepsPerSecond;
    this.lastTick = null;
    void this.prepare(this.pendingField).catch((error: unknown) =>
      this.reportError(error),
    );
    return true;
  }

  /** Decode the next chunk ahead of its swap, including its static mask. */
  preloadManifest(
    manifest: GeoVideoManifest,
    options: GeoVideoPlaybackReplaceOptions = {},
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
    options: GeoVideoPlaybackReplaceOptions,
  ): [number, number] | null {
    const current = this.manifest;
    if (
      !current ||
      manifest.encoding.kind !== current.encoding.kind ||
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

  async play(): Promise<void> {
    if (!this.field || this.pendingField || this.awaitingNext) {
      this.playOnReady = true;
      this.clock.setPlaying(true);
      return;
    }
    if (this.failed) {
      void this.prepare(this.field, this.clock.ms).catch((error: unknown) =>
        this.reportError(error),
      );
    }
    const ended = this.endEmitted;
    this.endEmitted = false;
    const range = this.playbackRange(this.field);
    if (ended) {
      this.setTime(range[0]);
    }
    this.lastTick = null;
    this.clock.setPlaying(true);
    this.repaint();
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
    this.repaint();
  }

  isPlaying(): boolean {
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
    this.stepsPerSecond = undefined;
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

  private playbackRange(field: GeoVideoField): [number, number] {
    return field.manifest.timeline.kind === "snapshot-loop"
      ? [field.times[0], field.times[field.times.length - 1]]
      : (this.timeRange ?? [
          field.times[0],
          field.times[field.times.length - 1],
        ]);
  }

  private createField(manifest: GeoVideoManifest): GeoVideoField {
    const field = new GeoVideoField(this.gl!, manifest, {
      repeatLongitude: false,
      animateSnapshot: true,
      onError: (error) => {
        if (this.field === field && !this.seeking) {
          this.reportError(error);
        }
      },
      onReady: () => this.repaint(),
    });
    return field;
  }

  private reportError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.name === "AbortError" || this.destroyed) {
      return;
    }
    this.playOnReady = false;
    this.awaitingNext = false;
    this.failed = true;
    this.seeking = true;
    this.clock.setPlaying(false);
    this.emit("status", { phase: "error", error: err });
    this.emit("error", err);
  }
}
