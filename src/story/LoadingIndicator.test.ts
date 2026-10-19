import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingIndicator } from "./LoadingIndicator";

afterEach(() => {
  vi.useRealTimers();
});

describe("LoadingIndicator", () => {
  it("does not reveal loads that finish inside the delay", () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const indicator = new LoadingIndicator(update);

    indicator.show();
    vi.advanceTimersByTime(100);
    indicator.hide();
    vi.advanceTimersByTime(500);

    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a revealed load visible for the minimum duration", () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const indicator = new LoadingIndicator(update);

    indicator.show();
    vi.advanceTimersByTime(120);
    expect(update).toHaveBeenLastCalledWith(true);

    vi.advanceTimersByTime(100);
    indicator.hide();
    vi.advanceTimersByTime(349);
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(update).toHaveBeenLastCalledWith(false);
  });

  it("can hide immediately when an error supersedes loading", () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const indicator = new LoadingIndicator(update);

    indicator.show();
    vi.advanceTimersByTime(120);
    indicator.hide(true);

    expect(update.mock.calls).toEqual([[true], [false]]);
  });
});
