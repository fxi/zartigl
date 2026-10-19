import { describe, expect, it, vi } from "vitest";
import {
  StoryScroller,
  activationMargin,
  type StoryScrollEntry,
  type StoryScrollObserverFactory,
} from "./scroller";

function harness(count: number, line?: number) {
  const sections = Array.from({ length: count }, () => ({}) as Element);
  let emit: (entries: readonly StoryScrollEntry[]) => void = () => {};
  let init: IntersectionObserverInit | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const createObserver: StoryScrollObserverFactory = (callback, options) => {
    emit = callback;
    init = options;
    return { observe, disconnect };
  };
  const onActivate = vi.fn();
  const scroller = new StoryScroller(sections, onActivate, {
    line,
    createObserver,
  });
  const cross = (index: number, isIntersecting = true) =>
    emit([{ target: sections[index], isIntersecting }]);
  return { scroller, sections, onActivate, observe, disconnect, cross, init };
}

describe("activationMargin", () => {
  it("shrinks the root to a thin band at the line", () => {
    expect(activationMargin(0.5)).toBe("-50% 0px -49% 0px");
    expect(activationMargin(0)).toBe("-0% 0px -99% 0px");
    expect(activationMargin(1)).toBe("-99% 0px -0% 0px");
  });
});

describe("StoryScroller", () => {
  it("observes every section on the activation band", () => {
    const { observe, init } = harness(3, 0.4);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(init?.rootMargin).toBe("-40% 0px -59% 0px");
  });

  it("activates the section crossing the line, once per change", () => {
    const { scroller, sections, onActivate, cross } = harness(3);
    expect(scroller.active).toBe(-1);
    cross(0);
    cross(0);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenLastCalledWith(0, sections[0]);
    cross(0, false);
    cross(1);
    expect(scroller.active).toBe(1);
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("keeps the last section active in a gap between sections", () => {
    const { scroller, onActivate, cross } = harness(2);
    cross(1);
    cross(1, false);
    expect(scroller.active).toBe(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("prefers the lower section while two share the band", () => {
    const { scroller, cross } = harness(3);
    cross(0);
    cross(1);
    expect(scroller.active).toBe(1);
    cross(1, false);
    expect(scroller.active).toBe(0);
  });

  it("ignores foreign targets and disconnects on destroy", () => {
    const { scroller, onActivate, disconnect } = harness(1);
    (scroller as unknown as { update(e: StoryScrollEntry[]): void }).update([
      { target: {} as Element, isIntersecting: true },
    ]);
    expect(onActivate).not.toHaveBeenCalled();
    scroller.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
