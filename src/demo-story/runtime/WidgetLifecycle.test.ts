import { describe, expect, it, vi } from "vitest";
import { StoryWidgetLifecycle } from "./WidgetLifecycle";

describe("StoryWidgetLifecycle", () => {
  it("aborts the previous run and invokes its cleanup exactly once", () => {
    const cleanup = vi.fn();
    const lifecycle = new StoryWidgetLifecycle();
    const first = lifecycle.begin();
    first.settle(cleanup);

    const second = lifecycle.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);

    lifecycle.cancel();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("immediately cleans a renderer that settles after becoming stale", () => {
    const cleanup = vi.fn();
    const lifecycle = new StoryWidgetLifecycle();
    const stale = lifecycle.begin();
    lifecycle.begin();

    stale.settle(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("prevents a stale widget from replacing active state", () => {
    const lifecycle = new StoryWidgetLifecycle();
    const arctic = lifecycle.begin();
    const enso = lifecycle.begin();
    let cursor = "none";

    enso.runIfCurrent(() => { cursor = "enso"; });
    arctic.runIfCurrent(() => { cursor = "arctic"; });
    expect(cursor).toBe("enso");
  });

  it("isolates cleanup errors from navigation", () => {
    const onError = vi.fn();
    const lifecycle = new StoryWidgetLifecycle(onError);
    const run = lifecycle.begin();
    run.settle(() => { throw new Error("cleanup failed"); });

    expect(() => lifecycle.cancel()).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });
});
