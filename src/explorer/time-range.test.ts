import { describe, expect, it } from "vitest";
import {
  buildLimitedTimeRange,
  isoTimeRange,
  normalizeSharedTimeRange,
  exportedSnippetTime,
} from "./time-range";

describe("buildLimitedTimeRange", () => {
  it.each([
    [false, false, undefined],
    [true, false, { start: 1 }],
    [false, true, { end: 10 }],
    [true, true, { start: 1, end: 10 }],
  ] as const)(
    "supports start=%s and end=%s",
    (limitStart, limitEnd, expected) => {
      expect(buildLimitedTimeRange(1, 10, limitStart, limitEnd)).toEqual(
        expected,
      );
    },
  );

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

describe("exportedSnippetTime", () => {
  it("omits any unpinned selection, including a forecast before its maximum", () => {
    expect(exportedSnippetTime(5, false)).toBeUndefined();
    expect(exportedSnippetTime(10, false)).toBeUndefined();
  });

  it("exports a pinned selection", () => {
    expect(exportedSnippetTime(5, true)).toEqual(new Date(5));
  });

  it("omits a pinned selection without a valid time", () => {
    expect(exportedSnippetTime(NaN, true)).toBeUndefined();
  });
});
