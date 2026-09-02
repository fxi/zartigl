import { describe, expect, it } from "vitest";
import {
  buildLimitedTimeRange,
  isoTimeRange,
  normalizeSharedTimeRange,
  shouldExportSelectedTime,
} from "./time-range";

describe("buildLimitedTimeRange", () => {
  it.each([
    [false, false, undefined],
    [true, false, { start: 1 }],
    [false, true, { end: 10 }],
    [true, true, { start: 1, end: 10 }],
  ] as const)("supports start=%s and end=%s", (limitStart, limitEnd, expected) => {
    expect(buildLimitedTimeRange(1, 10, limitStart, limitEnd)).toEqual(expected);
  });

  it("formats only enabled endpoints as ISO timestamps", () => {
    expect(isoTimeRange({ start: Date.UTC(2025, 0, 1) })).toEqual({
      start: "2025-01-01T00:00:00.000Z",
    });
  });
});

describe("normalizeSharedTimeRange", () => {
  it("accepts legacy two-ended tuples", () => {
    expect(normalizeSharedTimeRange([1, 10])).toEqual({ start: 1, end: 10 });
  });

  it("preserves partial endpoint objects", () => {
    expect(normalizeSharedTimeRange({ start: 1 })).toEqual({ start: 1 });
    expect(normalizeSharedTimeRange({ end: 10 })).toEqual({ end: 10 });
  });
});

describe("shouldExportSelectedTime", () => {
  it("omits an open-ended latest selection", () => {
    expect(shouldExportSelectedTime(10, 10, false)).toBe(false);
  });

  it("keeps historical and fixed-end selections", () => {
    expect(shouldExportSelectedTime(5, 10, false)).toBe(true);
    expect(shouldExportSelectedTime(10, 10, true)).toBe(true);
  });
});
