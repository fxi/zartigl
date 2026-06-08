import { describe, expect, it } from "vitest";
import {
  globeCenterVector,
  normalizeLongitude,
  particleUpdateBounds,
  viewportMercatorBounds,
} from "./geo-util";

function bounds(west: number, south: number, east: number, north: number) {
  return {
    getWest: () => west,
    getSouth: () => south,
    getEast: () => east,
    getNorth: () => north,
  };
}

describe("geo utilities", () => {
  it("normalizes longitudes into the primary world", () => {
    expect(normalizeLongitude(190)).toBe(-170);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(540)).toBe(-180);
  });

  it("keeps raw mercator x bounds for multi-world scalar rendering", () => {
    const result = viewportMercatorBounds(bounds(-540, -10, 540, 10));

    expect(result.minX).toBeCloseTo(-1);
    expect(result.maxX).toBeCloseTo(2);
  });

  it("uses full-world particle update bounds when the viewport crosses the dateline", () => {
    const result = particleUpdateBounds(bounds(170, -20, 190, 20));

    expect(result.minX).toBe(0);
    expect(result.maxX).toBe(1);
  });

  it("keeps particle update bounds local away from the dateline", () => {
    const result = particleUpdateBounds(bounds(-20, -20, 20, 20));

    expect(result.minX).toBeCloseTo(160 / 360);
    expect(result.maxX).toBeCloseTo(200 / 360);
  });

  it("folds particle update bounds from wrapped world copies into the primary world", () => {
    const result = particleUpdateBounds(bounds(190, -20, 220, 20));

    expect(result.minX).toBeCloseTo(10 / 360);
    expect(result.maxX).toBeCloseTo(40 / 360);
  });

  it("returns maplibre-compatible globe center vectors", () => {
    expect(globeCenterVector(0, 0)).toEqual([0, 0, 1]);
    expect(globeCenterVector(90, 0)[0]).toBeCloseTo(1);
    expect(globeCenterVector(0, 90)[1]).toBeCloseTo(1);
  });
});
