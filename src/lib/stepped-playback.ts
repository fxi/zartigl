export interface SteppedPlaybackOptions {
  /** Sorted time steps to play through. */
  values: readonly number[];
  time: number;
  stepsPerSecond: number;
  loop: boolean;
  /** Whether the frame for a time step is ready to show. */
  isReady: (time: number) => boolean;
  /** Request a frame ahead of the playhead. */
  prefetch: (time: number) => void;
  /** Show a time step. */
  onStep: (time: number) => void;
  onChange: (playing: boolean) => void;
  /** The last step was shown without looping. */
  onEnd: () => void;
}

/**
 * Timer playback through discrete time steps, for renderers that decode one
 * frame at a time (vector GeoVideo). The playhead only advances once the next
 * frame is ready, so a slow decode delays playback instead of skipping frames.
 */
export class SteppedPlayback {
  private values: readonly number[];
  private time: number;
  private stepsPerSecond: number;
  private loop: boolean;
  private playing = false;
  private halted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: SteppedPlaybackOptions;

  constructor(options: SteppedPlaybackOptions) {
    this.options = options;
    this.values = options.values;
    this.time = options.time;
    this.stepsPerSecond = positiveRate(options.stepsPerSecond);
    this.loop = options.loop;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  play(): void {
    if (this.playing || this.values.length < 2) {
      return;
    }
    this.playing = true;
    this.options.onChange(true);
    // Play again from the start once the end was reached.
    if (this.indexOf(this.time) >= this.values.length - 1) {
      this.time = this.values[0];
      this.options.onStep(this.time);
    }
    this.schedule();
  }

  pause(): void {
    this.clearTimer();
    if (!this.playing) {
      return;
    }
    this.playing = false;
    this.options.onChange(false);
  }

  /** Stop the timer without changing the playing state, as while suspended. */
  halt(): void {
    this.halted = true;
    this.clearTimer();
  }

  /** Continue after `halt()`. */
  resume(): void {
    this.halted = false;
    this.schedule();
  }

  /** Follow a time shown by the caller, such as a seek. */
  setTime(time: number): void {
    this.time = time;
  }

  setValues(values: readonly number[]): void {
    this.values = values;
    if (values.length < 2) {
      this.pause();
    }
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  setStepsPerSecond(stepsPerSecond: number): void {
    this.stepsPerSecond = positiveRate(stepsPerSecond);
    this.schedule();
  }

  destroy(): void {
    this.clearTimer();
    this.playing = false;
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.playing || this.halted) {
      return;
    }
    const next = this.nextTime();
    if (next != null) {
      this.options.prefetch(next);
    }
    this.timer = setTimeout(() => this.tick(), 1000 / this.stepsPerSecond);
  }

  private tick(): void {
    this.timer = null;
    if (!this.playing || this.halted) {
      return;
    }
    const next = this.nextTime();
    if (next == null) {
      this.playing = false;
      this.options.onChange(false);
      this.options.onEnd();
      return;
    }
    // Backpressure: wait for the frame instead of skipping it.
    if (this.options.isReady(next)) {
      this.time = next;
      this.options.onStep(next);
    }
    this.schedule();
  }

  private nextTime(): number | null {
    const index = this.indexOf(this.time) + 1;
    if (index < this.values.length) {
      return this.values[index];
    }
    return this.loop && this.values.length > 1 ? this.values[0] : null;
  }

  /** Index of the last step at or before the playhead. */
  private indexOf(time: number): number {
    let index = 0;
    for (let i = 0; i < this.values.length; i++) {
      if (this.values[i] <= time) {
        index = i;
      }
    }
    return index;
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function positiveRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Steps per second must be positive");
  }
  return rate;
}
