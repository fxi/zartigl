import { describe, expect, it } from "vitest";
import { timelinePosition, timelineTicks, type TimelineSpan } from "./Timeline";

/** Calendar months from `year`-`month` (1-based), `count` of them. */
function months(year: number, month: number, count: number): TimelineSpan[] {
  return Array.from({ length: count }, (_, i) => ({
    start: Date.UTC(year, month - 1 + i, 1),
    end: Date.UTC(year, month + i, 1) - 1,
  }));
}

describe("timelineTicks", () => {
  it("labels every month when they fit, January with its year", () => {
    const ticks = timelineTicks(months(2025, 11, 4), 800);
    expect(ticks.map((t) => t.text)).toEqual(["2025", "Dec", "2026", "Feb"]);
    expect(ticks.map((t) => t.major)).toEqual([true, false, true, false]);
    expect(ticks[0].x).toBe(0);
  });

  it("falls back to thinned years on a long archive", () => {
    const ticks = timelineTicks(months(1987, 1, 400), 600);
    expect(ticks.every((t) => t.major)).toBe(true);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(52);
    }
    expect(ticks[0].text).toBe("1987");
  });

  it("is empty without months or width", () => {
    expect(timelineTicks([], 500)).toEqual([]);
    expect(timelineTicks(months(2025, 1, 2), 0)).toEqual([]);
  });
});

describe("timelinePosition", () => {
  it("maps a time onto the whole archive, clamped", () => {
    const spans = months(2025, 1, 2);
    expect(timelinePosition(spans, spans[0].start)).toBe(0);
    expect(timelinePosition(spans, spans[1].end)).toBe(1);
    expect(timelinePosition(spans, Date.UTC(2030, 0, 1))).toBe(1);
  });
});
