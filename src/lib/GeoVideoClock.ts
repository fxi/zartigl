import { timeStep, stepTime } from "./time-bracket";

/** The playhead shared by the layers: time, play state and speeds. */
export class GeoVideoClock {
  private time = 0;
  private endFraction = 0;

  /** Playhead, epoch ms. Assigning it also resets a terminal step's hold. */
  get ms(): number {
    return this.time;
  }
  set ms(value: number) {
    this.time = value;
    this.endFraction = 0;
  }
  /** Playback held, e.g. while a timeline thumb is held. */
  held = false;
  private playingValue: boolean;

  constructor(
    playing: boolean,
    private readonly onPlaying: (playing: boolean) => void,
  ) {
    this.playingValue = playing;
  }

  get playing(): boolean {
    return this.playingValue;
  }

  setPlaying(playing: boolean): void {
    if (this.playingValue !== playing) {
      this.playingValue = playing;
      this.onPlaying(playing);
    }
  }

  /** Playing and not held. */
  get advancing(): boolean {
    return this.playingValue && !this.held;
  }

  /**
   * Advance in step units, including irregular timelines. Returns true at a
   * non-looping end. holdLastStep gives the final sample a full step's duration.
   */
  advance(
    dt: number,
    times: ArrayLike<number>,
    stepsPerSecond: number,
    range: readonly [number, number] = [times[0], times[times.length - 1]],
    loop = false,
    holdLastStep = false,
  ): boolean {
    if (!this.advancing || !times.length) {
      return false;
    }
    const start = timeStep(times, range[0]);
    const end = timeStep(times, range[1]);
    const limit = end + (holdLastStep ? 1 : 0);
    let step =
      Math.max(start, timeStep(times, this.ms) + this.endFraction) +
      Math.max(0, dt) * stepsPerSecond;
    const ended = holdLastStep ? step >= limit : step > limit;
    if (ended && loop && limit > start) {
      step = start + ((step - start) % (limit - start));
    } else {
      step = Math.min(limit, step);
    }
    this.time = stepTime(times, Math.min(end, step));
    this.endFraction = Math.max(0, step - end);
    return ended && !loop;
  }
}
