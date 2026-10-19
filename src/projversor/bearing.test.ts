import { geoEquirectangular, geoOrthographic } from "d3";
import { describe, expect, it } from "vitest";
import {
  normalizeBearing,
  pointerBearing,
  rotationBearing,
  screenNorth,
  type ScreenProjection,
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

describe("screenNorth", () => {
  const ortho = (rotate: [number, number, number]) =>
    geoOrthographic()
      .rotate(rotate)
      .translate([200, 200])
      .scale(150) as unknown as ScreenProjection;

  it("points up on a north-up view", () => {
    expect(screenNorth(ortho([-30, -40, 0]), [200, 200])).toBeCloseTo(0, 1);
  });

  it("follows the bearing of a turned view", () => {
    const north = screenNorth(ortho(withBearing([0, -20, 0], 30)), [200, 200]);
    expect(north).toBeCloseTo(30, 1);
  });

  it("tilts on a world map rotated off the equator", () => {
    const tilted = geoEquirectangular()
      .rotate([-140, -40, 0])
      .translate([200, 200])
      .scale(80) as unknown as ScreenProjection;
    // North of the center still points up; off center it leans.
    expect(screenNorth(tilted, [200, 200])).toBeCloseTo(0, 1);
    expect(Math.abs(screenNorth(tilted, [300, 200])!)).toBeGreaterThan(5);
  });

  it("has no direction at a pole or off the map", () => {
    expect(screenNorth(ortho([0, -90, 0]), [200, 200])).toBeNull();
    expect(screenNorth(ortho([0, 0, 0]), [395, 395])).toBeNull();
  });
});
