import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteppedPlayback } from "./stepped-playback";
import type { SteppedPlaybackOptions } from "./stepped-playback";

function create(overrides: Partial<SteppedPlaybackOptions> = {}) {
  const steps: number[] = [];
  const changes: boolean[] = [];
  const onEnd = vi.fn();
  const prefetch = vi.fn();
  const playback = new SteppedPlayback({
    values: [0, 1, 2, 3],
    time: 0,
    stepsPerSecond: 2,
    loop: false,
    isReady: () => true,
    prefetch,
    onStep: (time) => steps.push(time),
    onChange: (playing) => changes.push(playing),
    onEnd,
    ...overrides,
  });
  return { playback, steps, changes, onEnd, prefetch };
}

describe("SteppedPlayback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances one step per period at the requested cadence", () => {
    const { playback, steps, changes } = create();

    playback.play();
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(499);
    expect(steps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(steps).toEqual([1]);
    vi.advanceTimersByTime(500);
    expect(steps).toEqual([1, 2]);
  });

  it("stops at the last step without loop and reports the end", () => {
    const { playback, steps, changes, onEnd } = create({ time: 2 });

    playback.play();
    vi.advanceTimersByTime(2_000);

    expect(steps).toEqual([3]);
    expect(changes).toEqual([true, false]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(playback.isPlaying()).toBe(false);
  });

  it("wraps to the first step with loop", () => {
    const { playback, steps, onEnd } = create({ time: 2, loop: true });

    playback.play();
    vi.advanceTimersByTime(1_500);

    expect(steps).toEqual([3, 0, 1]);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("reports playing before rewinding from the end", () => {
    const events: Array<[string, unknown]> = [];
    const { playback } = create({
      time: 3,
      onStep: (time) => events.push(["step", time]),
      onChange: (playing) => events.push(["playing", playing]),
    });

    playback.play();

    expect(events).toEqual([
      ["playing", true],
      ["step", 0],
    ]);
  });

  it("waits for the next frame instead of skipping it", () => {
    let ready = false;
    const { playback, steps, prefetch } = create({ isReady: () => ready });

    playback.play();
    expect(prefetch).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(1_500);
    expect(steps).toEqual([]);
    ready = true;
    vi.advanceTimersByTime(500);
    expect(steps).toEqual([1]);
  });

  it("clears its timer on pause, halt and destroy", () => {
    const { playback, steps, changes } = create();

    playback.play();
    playback.pause();
    vi.advanceTimersByTime(2_000);
    expect(steps).toEqual([]);
    expect(changes).toEqual([true, false]);

    playback.play();
    playback.halt();
    vi.advanceTimersByTime(2_000);
    expect(steps).toEqual([]);
    expect(playback.isPlaying()).toBe(true);
    playback.resume();
    vi.advanceTimersByTime(500);
    expect(steps).toEqual([1]);

    playback.destroy();
    vi.advanceTimersByTime(2_000);
    expect(steps).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows a seek and a new cadence", () => {
    const { playback, steps } = create({ stepsPerSecond: 1 });

    playback.play();
    playback.setTime(2);
    playback.setStepsPerSecond(2);
    vi.advanceTimersByTime(500);

    expect(steps).toEqual([3]);
  });

  it("does not play a single step", () => {
    const { playback, changes } = create({ values: [0] });

    playback.play();

    expect(changes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
