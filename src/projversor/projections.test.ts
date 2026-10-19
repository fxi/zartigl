import { geoRotation } from "d3";
import { describe, expect, it } from "vitest";
import {
  AZIMUTHAL_CLIP,
  PROJECTIONS,
  applyMat3,
  blendClipAngle,
  blendRaw,
  cartesian,
  invertBlend,
  mollweideTheta,
  rotationMatrix,
  spherical,
  transpose,
  type Blend,
} from "./projections";
import { interpolateRotation, versor, versorRotation } from "./versor";

const blend = (
  t: number,
  a = "equalEarth",
  b = "azimuthalEqualArea",
): Blend => ({
  a: PROJECTIONS[a as keyof typeof PROJECTIONS],
  b: PROJECTIONS[b as keyof typeof PROJECTIONS],
  ka: 100,
  kb: 150,
  t,
});

describe("blendRaw", () => {
  it("is projection a at t = 0 and b at t = 1", () => {
    const p: [number, number] = [0.7, -0.4];
    const a = PROJECTIONS.equalEarth.raw(...p);
    const b = PROJECTIONS.azimuthalEqualArea.raw(...p);
    expect(blendRaw(blend(0))(...p)).toEqual([100 * a[0], 100 * a[1]]);
    expect(blendRaw(blend(1))(...p)).toEqual([150 * b[0], 150 * b[1]]);
  });
});

describe("invertBlend", () => {
  it.each([0, 0.3, 0.5, 1])(
    "round-trips the blended projection at t = %s",
    (t) => {
      const forward = blendRaw(blend(t));
      for (const p of [
        [0.2, 0.1],
        [-2.5, 0.9],
        [1.4, -1.2],
      ] as [number, number][]) {
        const inverse = invertBlend(blend(t), ...forward(...p));
        expect(inverse?.[0]).toBeCloseTo(p[0], 5);
        expect(inverse?.[1]).toBeCloseTo(p[1], 5);
      }
    },
  );

  it("inverts Mollweide", () => {
    const m = blend(0, "mollweide", "mollweide");
    const xy = blendRaw(m)(2, 1.3);
    const inverse = invertBlend(m, ...xy);
    expect(inverse?.[0]).toBeCloseTo(2, 6);
    expect(inverse?.[1]).toBeCloseTo(1.3, 6);
  });
});

describe("mollweideTheta", () => {
  it("solves 2θ + sin 2θ = π sin φ up to the poles", () => {
    for (const phi of [0, 0.5, 1.2, Math.PI / 2 - 1e-6, -1]) {
      const theta = mollweideTheta(phi);
      expect(2 * theta + Math.sin(2 * theta)).toBeCloseTo(
        Math.PI * Math.sin(phi),
        6,
      );
    }
  });
});

describe("blendClipAngle", () => {
  it("is the horizon for orthographic, none for world projections", () => {
    expect(blendClipAngle(blend(0.4))).toBe(180);
    expect(blendClipAngle(blend(0.6))).toBe(AZIMUTHAL_CLIP);
    expect(blendClipAngle(blend(1, "equalEarth", "orthographic"))).toBe(90);
  });

  it("moves outward continuously while leaving orthographic", () => {
    const angles = [0.9, 0.6, 0.3].map((t) =>
      blendClipAngle(blend(1 - t, "orthographic", "azimuthalEquidistant")),
    );
    expect(angles[0]).toBeGreaterThan(90);
    expect(angles[1]).toBeGreaterThan(angles[0]);
    // The fold vanishes once the world projection dominates.
    expect(angles[2]).toBe(AZIMUTHAL_CLIP);
  });
});

describe("rotationMatrix", () => {
  it("matches d3.geoRotation and inverts by transposition", () => {
    const rotate: [number, number, number] = [-35, 72, 12];
    const m = rotationMatrix(rotate);
    for (const p of [
      [10, 20],
      [-170, -60],
      [95, 80],
    ] as [number, number][]) {
      const expected = geoRotation(rotate)(p);
      const actual = spherical(applyMat3(m, cartesian(...p)));
      expect(actual[0]).toBeCloseTo(expected[0], 9);
      expect(actual[1]).toBeCloseTo(expected[1], 9);
      const back = spherical(applyMat3(transpose(m), cartesian(...actual)));
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
    }
  });
});

describe("versor", () => {
  it("round-trips Euler angles", () => {
    const r = versorRotation(versor([40, -30, 10]));
    expect(r[0]).toBeCloseTo(40, 9);
    expect(r[1]).toBeCloseTo(-30, 9);
    expect(r[2]).toBeCloseTo(10, 9);
  });

  it("interpolates rotations end to end", () => {
    const i = interpolateRotation([0, 0, 0], [20, 90, 0]);
    expect(i(0)[1]).toBeCloseTo(0, 9);
    expect(i(1)[1]).toBeCloseTo(90, 5);
  });
});
