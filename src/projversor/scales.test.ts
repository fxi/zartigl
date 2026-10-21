import { describe, expect, it } from "vitest";
import {
  chunkLabel,
  legendLabels,
  monthLegend,
  playheadLabel,
  timeTicks,
  formatUnit,
  linearTicks,
  particleSpeedFactor,
  legendTicks,
  MAX_PARTICLES,
  particleCount,
  rampGradient,
  rampPosition,
} from "./scales";

describe("rampGradient", () => {
  it("lists stops in ascending order", () => {
    const positions = [...rampGradient("plasma").matchAll(/ ([\d.]+)%/g)].map(
      (m) => Number(m[1]),
    );
    expect(positions[0]).toBe(0);
    expect(positions[positions.length - 1]).toBe(100);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("legendTicks", () => {
  it("spans zero to the maximum with rounded values", () => {
    expect(legendTicks(1.2)).toEqual([0, 0.08, 0.25, 0.5, 0.8, 1.2]);
    expect(legendTicks(20)).toEqual([0, 1.5, 4, 8, 15, 20]);
  });

  it("places values on the square-root ramp", () => {
    expect(rampPosition(0.3, 1.2)).toBeCloseTo(0.5, 9);
    expect(rampPosition(5, 1.2)).toBe(1);
  });
});

describe("timeTicks", () => {
  it("marks every UTC day, the 1st and every 5th as major", () => {
    const first = Date.UTC(2026, 9, 1);
    const last = Date.UTC(2026, 9, 11);
    const ticks = timeTicks(first, last);
    expect(ticks).toHaveLength(11);
    expect(ticks.filter((t) => t.major)).toEqual([
      { label: "01", position: 0, major: true },
      { label: "05", position: 0.4, major: true },
      { label: "10", position: 0.9, major: true },
    ]);
    expect(ticks[1]).toEqual({ label: "02", position: 0.1, major: false });
  });

  it("marks months over a year, quarters major, January as the year", () => {
    const ticks = timeTicks(Date.UTC(2025, 10, 15), Date.UTC(2026, 10, 15));
    expect(ticks).toHaveLength(12);
    expect(ticks.slice(0, 3).map((t) => t.label)).toEqual([
      "Dec",
      "2026",
      "Feb",
    ]);
    expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual([
      "2026",
      "Apr",
      "Jul",
      "Oct",
    ]);
  });

  it("marks years over a decade chunk of monthly samples", () => {
    const ticks = timeTicks(Date.UTC(2020, 0, 1), Date.UTC(2026, 8, 1));
    expect(ticks.map((t) => t.label)).toEqual([
      "2020",
      "2021",
      "2022",
      "2023",
      "2024",
      "2025",
      "2026",
    ]);
    expect(ticks[0].position).toBe(0);
    expect(ticks.every((t) => t.major)).toBe(true);
  });

  it("keeps every 5th year major past twelve years", () => {
    const ticks = timeTicks(Date.UTC(1987, 0, 1), Date.UTC(2006, 0, 1));
    expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual([
      "1990",
      "1995",
      "2000",
      "2005",
    ]);
  });
});

describe("chunkLabel", () => {
  it("names a month chunk by its month", () => {
    expect(chunkLabel("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z")).toMatch(
      /^Sep.* ’26$/,
    );
  });

  it("names a longer chunk by the years it covers", () => {
    expect(chunkLabel("2020-01-01T00:00:00Z", "2026-09-01T00:00:00Z")).toBe(
      "’20–’26",
    );
    expect(chunkLabel("2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z")).toBe(
      "2026",
    );
    expect(chunkLabel(undefined)).toBe("—");
  });
});

describe("playheadLabel", () => {
  const ms = Date.UTC(2025, 2, 14, 7);

  it("shows the hour below daily steps", () => {
    expect(playheadLabel(ms, 6 * 3_600_000)).toEqual({
      date: "14 MAR 2025",
      hour: "07:00 UTC",
    });
  });

  it("drops the hour for daily steps, the day for monthly ones", () => {
    expect(playheadLabel(ms, 86_400_000)).toEqual({
      date: "14 MAR 2025",
      hour: "",
    });
    expect(playheadLabel(ms, 30 * 86_400_000)).toEqual({
      date: "MAR 2025",
      hour: "",
    });
  });
});

describe("particleSpeedFactor", () => {
  it("maps 0.5× to 0.2 and 5× to the natural particle speed", () => {
    expect(particleSpeedFactor(0.5)).toBeCloseTo(0.2, 9);
    expect(particleSpeedFactor(5)).toBeCloseTo(1, 9);
  });

  it("rises evenly on a log scale in between", () => {
    expect(particleSpeedFactor(1)).toBeCloseTo(0.325, 3);
    expect(particleSpeedFactor(2)).toBeCloseTo(0.527, 3);
  });
});

describe("linearTicks", () => {
  it("places round values linearly within the domain", () => {
    const ticks = linearTicks(-1.74, 30.04);
    expect(ticks.map((t) => t.value)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(ticks[0].position).toBeCloseTo(1.74 / 31.78, 9);
    expect(ticks[ticks.length - 1].position).toBeLessThanOrEqual(1);
  });

  it("includes both ends when they are round", () => {
    expect(linearTicks(0, 1).map((t) => t.value)).toEqual([
      0, 0.2, 0.4, 0.6, 0.8, 1,
    ]);
  });
});

describe("formatUnit", () => {
  it("writes per-second units with a slash", () => {
    expect(formatUnit("m s-1")).toBe("m/s");
    expect(formatUnit("degrees_C")).toBe("°C");
    expect(formatUnit("m")).toBe("m");
  });
});

describe("particleCount", () => {
  it("counts particles per device pixel, capped by the state texture", () => {
    const at = (density: number) => particleCount({ density }, 2500, 1680);
    expect(at(0.004)).toBe(16800);
    expect(at(0.2)).toBe(MAX_PARTICLES);
    expect(at(0)).toBe(1);
  });
});

describe("monthLegend", () => {
  const field = (vector: boolean, domain: [number, number], unit: string) => ({
    vector,
    domain,
    maxSpeed: vector ? 1.5 : domain[1],
    manifest: { style: { unit } },
  });

  it("shows a scalar raster over its domain", () => {
    expect(
      monthLegend({ field: field(false, [-2, 32], "degrees_C"), tint: null }),
    ).toEqual({ min: -2, max: 32, unit: "°C", ramp: "linear" });
  });

  it("shows the tint of tinted particles, not their speed", () => {
    expect(
      monthLegend({
        field: field(true, [0, 1.5], "m s-1"),
        tint: field(false, [0, 30], "degrees_C"),
      }),
    ).toEqual({ min: 0, max: 30, unit: "°C", ramp: "linear" });
  });

  it("shows the speed of plain particles on a square-root ramp", () => {
    expect(
      monthLegend({ field: field(true, [0, 1.5], "m s-1"), tint: null }),
    ).toEqual({ min: 0, max: 1.5, unit: "m/s", ramp: "sqrt" });
  });
});

describe("legendLabels", () => {
  it("rounds the ends to the precision of their range", () => {
    expect(legendLabels(0.00000537, 0.665)).toEqual(["0", "0.67"]);
    expect(legendLabels(-1.74, 35)).toEqual(["-2", "35"]);
    expect(legendLabels(0, 6.3)).toEqual(["0", "6.3"]);
    expect(legendLabels(0.0012, 0.0087)).toEqual(["0.0012", "0.0087"]);
  });

  it("never shows a negative zero", () => {
    expect(legendLabels(-0.004, 0.665)).toEqual(["0", "0.67"]);
  });

  it("follows the locale", () => {
    expect(legendLabels(0, 0.665, "fr")).toEqual(["0", "0,67"]);
  });
});
