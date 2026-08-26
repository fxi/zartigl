import { describe, expect, it } from "vitest";
import { formatHypoxiaReadout, nearestChartTime, spreadChartLabels } from "./StoryCharts";

describe("nearestChartTime", () => {
  const times = [100, 200, 400, 800];

  it("snaps to the closest available timestamp", () => {
    expect(nearestChartTime(times, 249)).toBe(200);
    expect(nearestChartTime(times, 301)).toBe(400);
    expect(nearestChartTime(times, 300)).toBe(200);
  });

  it("clamps requests beyond either endpoint", () => {
    expect(nearestChartTime(times, -1)).toBe(100);
    expect(nearestChartTime(times, 999)).toBe(800);
  });
});

describe("spreadChartLabels", () => {
  it("preserves series order while separating crowded labels", () => {
    const labels = spreadChartLabels([50, 52, 51, 110], 20, 120, 15);

    expect(labels[0]).toBeLessThan(labels[2]);
    expect(labels[2]).toBeLessThan(labels[1]);
    expect(labels[1] - labels[2]).toBeGreaterThanOrEqual(15);
    expect(labels[3]).toBeLessThanOrEqual(120);
  });

  it("keeps labels inside the available plot height", () => {
    const labels = spreadChartLabels([0, 2, 99, 100], 10, 90, 14);

    expect(Math.min(...labels)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...labels)).toBeLessThanOrEqual(90);
  });
});

describe("formatHypoxiaReadout", () => {
  it("formats the monthly extent and affected fraction", () => {
    expect(formatHypoxiaReadout({
      time: "1994-09-01T00:00:00Z",
      hypoxicAreaKm2: 2500,
      hypoxicFractionPct: 25,
    })).toBe("SEP 1994 · 2,500 km² · 25%");
  });
});
