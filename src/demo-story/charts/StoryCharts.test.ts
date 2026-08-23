import { describe, expect, it } from "vitest";
import { nearestChartTime } from "./StoryCharts";

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
