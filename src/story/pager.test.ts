import { afterEach, describe, expect, it, vi } from "vitest";
import { StorySceneTimer, storyPagerItems } from ".";

describe("storyPagerItems", () => {
  it("shows every step when they fit", () => {
    expect(storyPagerItems(0, 0)).toEqual([]);
    expect(storyPagerItems(7, 3)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps the first, the last and the current step's neighbours", () => {
    expect(storyPagerItems(12, 6)).toEqual([0, "gap", 5, 6, 7, "gap", 11]);
  });

  it("shows the edge run instead of a gap hiding a single step", () => {
    expect(storyPagerItems(12, 3)).toEqual([0, 1, 2, 3, 4, "gap", 11]);
    expect(storyPagerItems(12, 8)).toEqual([0, "gap", 7, 8, 9, 10, 11]);
  });

  it("always fills the slots and hides at least two steps per gap", () => {
    for (const slots of [5, 7, 9]) {
      for (let count = slots + 1; count < 20; count++) {
        for (let current = 0; current < count; current++) {
          const items = storyPagerItems(count, current, slots);
          expect(items).toHaveLength(slots);
          expect(items[0]).toBe(0);
          expect(items[items.length - 1]).toBe(count - 1);
          expect(items).toContain(current);
          items.forEach((item, i) => {
            if (item === "gap") {
              const before = items[i - 1] as number;
              const after = items[i + 1] as number;
              expect(after - before).toBeGreaterThanOrEqual(3);
            }
          });
        }
      }
    }
  });
});

describe("StorySceneTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after its duration and keeps elapsed time across pauses", () => {
    vi.useFakeTimers();
    let now = 0;
    const done = vi.fn();
    const timer = new StorySceneTimer(done, () => now);
    timer.start(1000);
    now = 400;
    vi.advanceTimersByTime(400);
    timer.pause();
    expect(timer.progress).toBeCloseTo(0.4);
    now = 5000;
    vi.advanceTimersByTime(4600);
    expect(done).not.toHaveBeenCalled();
    timer.resume();
    now = 5600;
    vi.advanceTimersByTime(600);
    expect(done).toHaveBeenCalledTimes(1);
    expect(timer.progress).toBe(1);
    expect(timer.running).toBe(false);
  });

  it("starts paused on request and stops without firing", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const timer = new StorySceneTimer(done, () => 0);
    timer.start(500, true);
    expect(timer.running).toBe(false);
    timer.resume();
    timer.stop();
    vi.advanceTimersByTime(1000);
    expect(done).not.toHaveBeenCalled();
    expect(timer.progress).toBe(0);
  });
});
