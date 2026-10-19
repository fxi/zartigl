/**
 * Auto-advance clock of one scene: runs for a duration, pauses and resumes
 * keeping the elapsed time, and calls `onDone` once when it runs out.
 */
export class StorySceneTimer {
  private durationMs = 0;
  private elapsedMs = 0;
  private startedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onDone: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Restart from zero; runs at once unless `paused`. */
  start(durationMs: number, paused = false): void {
    this.stop();
    this.durationMs = Math.max(0, durationMs);
    this.elapsedMs = 0;
    if (!paused) {
      this.resume();
    }
  }

  get running(): boolean {
    return this.startedAt !== null;
  }

  /** Elapsed share of the duration, 0–1. */
  get progress(): number {
    if (this.durationMs <= 0) {
      return 0;
    }
    const running = this.startedAt === null ? 0 : this.now() - this.startedAt;
    return Math.min(1, (this.elapsedMs + running) / this.durationMs);
  }

  pause(): void {
    if (this.startedAt === null) {
      return;
    }
    this.elapsedMs += this.now() - this.startedAt;
    this.startedAt = null;
    this.clear();
  }

  resume(): void {
    if (this.startedAt !== null || this.durationMs <= 0) {
      return;
    }
    const remaining = this.durationMs - this.elapsedMs;
    if (remaining <= 0) {
      return;
    }
    this.startedAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.elapsedMs = this.durationMs;
      this.startedAt = null;
      this.onDone();
    }, remaining);
  }

  /** Stop without firing; the progress drops to zero. */
  stop(): void {
    this.clear();
    this.startedAt = null;
    this.elapsedMs = 0;
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
