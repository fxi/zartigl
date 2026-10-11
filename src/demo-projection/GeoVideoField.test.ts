import { describe, expect, it } from "vitest";
import { scalarTexels, timeBracket, velocityTexels } from "./GeoVideoField";

describe("field texels", () => {
  it("packs scalar values as (value, validity), zero where masked", () => {
    expect(Array.from(scalarTexels(new Float32Array([12.5, NaN])))).toEqual([
      12.5, 1, 0, 0,
    ]);
  });

  it("packs vector components as (u, v, validity, 0)", () => {
    const texels = velocityTexels({
      u: new Float32Array([0.5, NaN]),
      v: new Float32Array([-0.25, 1]),
    });
    expect(Array.from(texels)).toEqual([0.5, -0.25, 1, 0, 0, 0, 0, 0]);
  });
});

describe("timeBracket", () => {
  it("finds the step at or before a time and the fraction to the next", () => {
    expect(timeBracket([0, 10, 20], 15)).toEqual({ index: 1, fraction: 0.5 });
    expect(timeBracket([0, 10, 20], -5)).toEqual({ index: 0, fraction: 0 });
    expect(timeBracket([0, 10, 20], 25)).toEqual({ index: 2, fraction: 0 });
  });
});
