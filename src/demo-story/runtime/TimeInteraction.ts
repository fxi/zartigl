export interface StoryTimeInteractionCallbacks {
  isPlaying(): boolean;
  pause(): void;
  apply(time: number): void;
  present(time: number): void;
  finish(time: number | null, resume: boolean): void;
}

export interface StoryFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

const browserFrames: StoryFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** Coordinates an immediate cursor update with at most one layer seek per frame. */
export class StoryTimeInteraction {
  private active = false;
  private resumeAfterInteraction = false;
  private latestTime: number | null = null;
  private appliedTime: number | null = null;
  private frame: number | null = null;

  constructor(
    private readonly callbacks: StoryTimeInteractionCallbacks,
    private readonly frames: StoryFrameScheduler = browserFrames,
  ) {}

  get interacting(): boolean { return this.active; }

  begin(): void {
    if (this.active) return;
    this.active = true;
    this.resumeAfterInteraction = this.callbacks.isPlaying();
    this.latestTime = null;
    this.appliedTime = null;
    this.callbacks.pause();
  }

  request(time: number): void {
    if (!this.active || !Number.isFinite(time)) return;
    this.latestTime = time;
    this.callbacks.present(time);
    if (this.frame !== null) return;
    this.frame = this.frames.request(() => {
      this.frame = null;
      if (!this.active || this.latestTime === null) return;
      this.applyLatest();
    });
  }

  end(): void {
    if (!this.active) return;
    this.cancelFrame();
    if (this.latestTime !== null && this.latestTime !== this.appliedTime) this.applyLatest();
    const time = this.latestTime;
    const resume = this.resumeAfterInteraction;
    this.active = false;
    this.latestTime = null;
    this.appliedTime = null;
    this.resumeAfterInteraction = false;
    this.callbacks.finish(time, resume);
  }

  /** Abandons pending work without resuming playback (for navigation/cleanup). */
  cancel(): void {
    this.cancelFrame();
    this.active = false;
    this.latestTime = null;
    this.appliedTime = null;
    this.resumeAfterInteraction = false;
  }

  private applyLatest(): void {
    const time = this.latestTime;
    if (time === null) return;
    this.appliedTime = time;
    this.callbacks.apply(time);
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    this.frames.cancel(this.frame);
    this.frame = null;
  }
}
