import { describe, expect, it } from "vitest";
import {
  dayTicks,
  formatUnit,
  legendTicks,
  particleBudget,
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
  it("marks the 1st and every 5th UTC day", () => {
    const first = Date.UTC(2026, 9, 1);
    const last = Date.UTC(2026, 9, 11);
    expect(dayTicks(first, last)).toEqual([
      { label: "01", position: 0 },
      { label: "05", position: 0.4 },
      { label: "10", position: 0.9 },
    ]);
  });
});

describe("formatUnit", () => {
  it("writes per-second units with a slash", () => {
    expect(formatUnit("m s-1")).toBe("m/s");
    expect(formatUnit("m")).toBe("m");
  });
});

describe("particleSettings", () => {
  it("layers demo defaults, catalog defaults, then the local override", () => {
    expect(particleSettings(undefined, undefined)).toEqual({
      density: 0.033,
      speed: 1,
      fade: 0.7,
    });
    expect(
      particleSettings({ density: 0.004, fade: 0.5 }, { fade: 0.9 }),
    ).toEqual({ density: 0.004, speed: 1, fade: 0.9 });
  });
});

describe("particleBudget", () => {
  it("counts particles per device pixel, capped by the state texture", () => {
    const wind = particleBudget(
      { density: 0.004, speed: 1, fade: 0.7 },
      2500,
      1680,
    );
    expect(wind.count).toBe(16800);
    const currents = particleBudget(
      { density: 0.033, speed: 1, fade: 0.7 },
      2500,
      1680,
    );
    expect(currents.count).toBe(65536);
  });

  it("maps fade geometrically to trail segments and scales speed", () => {
    const at = (fade: number) =>
      particleBudget({ density: 0.01, speed: 2, fade }, 100, 100);
    expect([at(0).segments, at(0.7).segments, at(1).segments]).toEqual([
      8, 21, 31,
    ]);
    expect(at(0.7).speed).toBeCloseTo(3.2, 9);
  });
});
