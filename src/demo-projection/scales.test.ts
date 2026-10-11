import { describe, expect, it } from "vitest";
import {
  dayTicks,
  formatUnit,
  linearTicks,
  particleSpeedFactor,
  legendTicks,
  MAX_PARTICLES,
  particleCount,
  particleSettings,
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

describe("dayTicks", () => {
  it("marks every UTC day, the 1st and every 5th as major", () => {
    const first = Date.UTC(2026, 9, 1);
    const last = Date.UTC(2026, 9, 11);
    const ticks = dayTicks(first, last);
    expect(ticks).toHaveLength(11);
    expect(ticks.filter((t) => t.major)).toEqual([
      { label: "01", position: 0, major: true },
      { label: "05", position: 0.4, major: true },
      { label: "10", position: 0.9, major: true },
    ]);
    expect(ticks[1]).toEqual({ label: "02", position: 0.1, major: false });
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

describe("particleSettings", () => {
  it("layers zartigl defaults, catalog defaults, then the local override", () => {
    expect(particleSettings(undefined, undefined)).toEqual({
      density: 0.05,
      speed: 1,
      fade: 0.7,
    });
    expect(
      particleSettings({ density: 0.004, fade: 0.5 }, { fade: 0.9 }),
    ).toEqual({ density: 0.004, speed: 1, fade: 0.9 });
  });
});

describe("particleCount", () => {
  it("counts particles per device pixel, capped by the state texture", () => {
    const at = (density: number) =>
      particleCount({ density, speed: 1, fade: 0.7 }, 2500, 1680);
    expect(at(0.004)).toBe(16800);
    expect(at(0.2)).toBe(MAX_PARTICLES);
    expect(at(0)).toBe(1);
  });
});
