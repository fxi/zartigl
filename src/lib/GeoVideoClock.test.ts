import { describe, expect, it, vi } from "vitest";
import { GeoVideoClock } from "./GeoVideoClock";
import { stepTime, timeBracket, timeStep } from "./time-bracket";

const times = [1000, 2000, 5000, 6000];

describe("GeoVideoClock", () => {
  it.each([0.01, 0.5, 1, 5, 80])(
    "advances at %s steps per second independently of frame pacing",
    (speed) => {
      const clock = new GeoVideoClock(true, vi.fn());
      clock.ms = times[0];
      for (const dt of [0.003, 0.027, 0.006, 0.014]) {
        clock.advance(dt, times, speed);
      }
      expect(timeStep(times, clock.ms)).toBeCloseTo(Math.min(3, 0.05 * speed));
    },
  );

  it("interpolates irregular sample times in step units", () => {
    const clock = new GeoVideoClock(true, vi.fn());
    clock.ms = times[0];
    expect(clock.advance(0.75, times, 2)).toBe(false);
    expect(clock.ms).toBe(3500);
    expect(timeBracket(times, clock.ms)).toEqual({ index: 1, fraction: 0.5 });
    expect(stepTime(times, 1.5)).toBe(3500);
  });

  it("wraps with the fractional overshoot inside a time range", () => {
    const clock = new GeoVideoClock(true, vi.fn());
    clock.ms = 5000;
    expect(clock.advance(0.5, times, 1, [2000, 5000], true)).toBe(false);
    expect(clock.ms).toBe(3500);
  });

  it("clamps at a non-looping end and leaves handoff policy to the caller", () => {
    const clock = new GeoVideoClock(true, vi.fn());
    clock.ms = 5000;
    expect(clock.advance(20, times, 1)).toBe(true);
    expect(clock.ms).toBe(6000);
    expect(clock.playing).toBe(true);
  });

  it("does not advance while held or paused and emits only playback changes", () => {
    const changed = vi.fn();
    const clock = new GeoVideoClock(false, changed);
    clock.ms = 2000;
    clock.advance(1, times, 1);
    clock.setPlaying(true);
    clock.setPlaying(true);
    clock.held = true;
    clock.advance(1, times, 1);
    expect(clock.ms).toBe(2000);
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("handles a single sample without NaN or spurious loop ends", () => {
    const clock = new GeoVideoClock(true, vi.fn());
    expect(clock.advance(1, [1000], 1, undefined, true)).toBe(false);
    expect(clock.ms).toBe(1000);
    expect(timeBracket(new Float64Array([1000]), 900)).toEqual({
      index: 0,
      fraction: 0,
    });
  });
});

describe("GeoVideoClock terminal sample", () => {
  it("holds a one-sample range for its full step duration", () => {
    const clock = new GeoVideoClock(true, vi.fn());
    clock.ms = 1000;
    expect(clock.advance(0.5, [1000], 1, undefined, false, true)).toBe(false);
    expect(clock.ms).toBe(1000);
    expect(clock.advance(0.5, [1000], 1, undefined, false, true)).toBe(true);
  });

  it("wraps after holding the last step and resets the hold on a seek", () => {
    const clock = new GeoVideoClock(true, vi.fn());
    clock.ms = 2000;
    clock.advance(0.75, [1000, 2000], 1, undefined, true, true);
    expect(clock.ms).toBe(2000);
    clock.advance(0.5, [1000, 2000], 1, undefined, true, true);
    expect(clock.ms).toBe(1250);
    clock.ms = 2000;
    expect(clock.advance(0.5, [1000, 2000], 1, undefined, false, true)).toBe(
      false,
    );
  });
});
