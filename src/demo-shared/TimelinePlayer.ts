import type { ParticleLayer } from "../lib/index.js";

export interface TimelineConfig {
  timeMin: number;
  timeStep: number;
  timeSize: number;
  bufferAhead?: number; // default 10
  frameMs?: number;     // default 200 (5fps)
}

export type PlayerState = "playing" | "paused" | "buffering";

export class TimelinePlayer {
  private layer: ParticleLayer;
  private cfg: Required<TimelineConfig>;
  private currentIndex: number;
  private _state: PlayerState = "paused";
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private frameStartTime = 0;
  private bufferWaitHandler: ((ms: number) => void) | null = null;
  private cacheInvalidatedHandler: () => void;

  onStateChange?: (state: PlayerState) => void;
  onFrameChange?: (index: number, ms: number) => void;

  get state(): PlayerState {
    return this._state;
  }

  constructor(layer: ParticleLayer, startIndex: number, cfg: TimelineConfig) {
    this.layer = layer;
    this.currentIndex = startIndex;
    this.cfg = {
      bufferAhead: cfg.bufferAhead ?? 10,
      frameMs: cfg.frameMs ?? 200,
      timeMin: cfg.timeMin,
      timeStep: cfg.timeStep,
      timeSize: cfg.timeSize,
    };

    this.cacheInvalidatedHandler = () => {
      if (this._state === "paused") return;
      this.prefetchAhead(this.currentIndex);
    };
    this.layer.on("cacheInvalidated", this.cacheInvalidatedHandler);
  }

  private msAt(i: number): number {
    return this.cfg.timeMin + i * this.cfg.timeStep;
  }

  play(): void {
    if (this._state !== "paused") return;
    this.setState("playing");
    this.prefetchAhead(this.currentIndex);
    this.frameStartTime = Date.now();
    this.advance(); // immediate: shows buffering right away if next frame not ready
  }

  pause(): void {
    if (this._state === "paused") return;
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.bufferWaitHandler) {
      this.layer.off("frameBuffered", this.bufferWaitHandler);
      this.bufferWaitHandler = null;
    }
    this.layer.cancelPrefetches();
    this.setState("paused");
  }

  private advance(): void {
    if (this._state === "paused") return;

    const nextIndex = (this.currentIndex + 1) % this.cfg.timeSize;
    const nextMs = this.msAt(nextIndex);

    if (this.layer.isFrameCached(nextMs)) {
      this.applyFrame(nextIndex, nextMs);
      this.prefetchAhead(nextIndex);
      this.scheduleNext();
      return;
    }

    // Stall: wait for frame to buffer
    this.setState("buffering");
    const handler = (bufferedMs: number) => {
      if (bufferedMs !== nextMs) return;
      this.layer.off("frameBuffered", handler);
      this.bufferWaitHandler = null;
      if (this._state === "paused") return;
      this.setState("playing");
      this.applyFrame(nextIndex, nextMs);
      this.prefetchAhead(nextIndex);
      this.frameStartTime = Date.now(); // reset drift tracking after stall
      this.scheduleNext();
    };
    this.bufferWaitHandler = handler;
    this.layer.on("frameBuffered", handler);

    // Race-condition fix: re-check after registering handler
    if (this.layer.isFrameCached(nextMs)) {
      this.layer.off("frameBuffered", handler);
      this.bufferWaitHandler = null;
      this.setState("playing");
      this.applyFrame(nextIndex, nextMs);
      this.prefetchAhead(nextIndex);
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    const elapsed = Date.now() - this.frameStartTime;
    const delay = Math.max(0, this.cfg.frameMs - elapsed);
    this.frameTimer = setTimeout(() => {
      this.frameStartTime = Date.now();
      this.advance();
    }, delay);
  }

  private applyFrame(index: number, ms: number): void {
    this.currentIndex = index;
    this.layer.setTime(ms);
    this.onFrameChange?.(index, ms);
  }

  private prefetchAhead(fromIndex: number): void {
    for (let i = 1; i <= this.cfg.bufferAhead; i++) {
      const idx = (fromIndex + i) % this.cfg.timeSize;
      this.layer.prefetchTime(this.msAt(idx));
    }
  }

  private setState(s: PlayerState): void {
    if (this._state === s) return;
    this._state = s;
    this.onStateChange?.(s);
  }

  dispose(): void {
    this.layer.off("cacheInvalidated", this.cacheInvalidatedHandler);
    this.pause();
  }
}
