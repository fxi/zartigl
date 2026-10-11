import { describe, expect, it } from "vitest";
import {
  normalizeBearing,
  pointerBearing,
  rotationBearing,
  withBearing,
} from "./bearing";

describe("bearing", () => {
  it("wraps into [-180, 180)", () => {
    expect(normalizeBearing(0)).toBe(0);
    expect(normalizeBearing(190)).toBe(-170);
    expect(normalizeBearing(-190)).toBe(170);
    expect(normalizeBearing(180)).toBe(-180);
    expect(normalizeBearing(720 + 45)).toBe(45);
  });

  it("measures pointer angles clockwise from up", () => {
    expect(pointerBearing(0, 0, 0, -1)).toBeCloseTo(0);
    expect(pointerBearing(0, 0, 1, 0)).toBeCloseTo(90);
    expect(pointerBearing(0, 0, 0, 1)).toBeCloseTo(180);
    expect(pointerBearing(0, 0, -1, 0)).toBeCloseTo(-90);
  });

  it("round-trips through the d3 gamma, keeping lambda and phi", () => {
    const rotate = withBearing([10, -20, 5], 30);
    expect(rotate.slice(0, 2)).toEqual([10, -20]);
    expect(rotationBearing(rotate)).toBeCloseTo(30);
    expect(rotationBearing([0, 0, 0])).toBe(0);
  });
});
