import { describe, expect, it } from "vitest";
import { PRESETS, frame, transform, viewMatrix } from "./camera";

function viewOf(preset: keyof typeof PRESETS, p: number[]) {
  // + 0 turns −0 into 0.
  return transform(viewMatrix(PRESETS[preset]), p).map(
    (v) => Math.round(v * 1e6) / 1e6 + 0,
  );
}

describe("camera presets", () => {
  it("FRONT looks north: east is right, up is up, south is near", () => {
    expect(viewOf("front", [1, 0, 0])).toEqual([1, 0, 0]);
    expect(viewOf("front", [0, 0, 1])).toEqual([0, 1, 0]);
    expect(viewOf("front", [0, -1, 0])).toEqual([0, 0, 1]);
  });

  it("TOP looks down with north up, SIDE looks west with north right", () => {
    expect(viewOf("top", [0, 1, 0])).toEqual([0, 1, 0]);
    expect(viewOf("top", [0, 0, 1])).toEqual([0, 0, 1]);
    expect(viewOf("side", [0, 1, 0])).toEqual([1, 0, 0]);
    expect(viewOf("side", [1, 0, 0])).toEqual([0, 0, 1]);
  });

  it("CAVALIER keeps the front face true and draws north up and to the right", () => {
    expect(viewOf("cavalier", [1, 0, 0])).toEqual([1, 0, 0]);
    expect(viewOf("cavalier", [0, 0, 1])).toEqual([0, 1, 0]);
    const north = viewOf("cavalier", [0, 1, 0]);
    expect(north[0]).toBeGreaterThan(0.3);
    expect(north[1]).toBeGreaterThan(0.2);
    expect(Math.hypot(north[0], north[1])).toBeCloseTo(0.5, 5);
  });

  it("gives the ray into the screen and inverts the projection", () => {
    const f = frame(PRESETS.top, 2);
    expect(f.ray.map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 0, -1]);
    const p = [0.3, -0.2, 0.1];
    const back = transform(f.inverse, transform(f.viewProjection, p));
    back.forEach((v, i) => expect(v).toBeCloseTo(p[i], 5));
    const oblique = frame(PRESETS.cavalier, 1);
    // Points along the ray land on one pixel.
    const a = transform(oblique.viewProjection, [0, 0, 0]);
    const b = transform(oblique.viewProjection, oblique.ray);
    expect(b[0]).toBeCloseTo(a[0], 5);
    expect(b[1]).toBeCloseTo(a[1], 5);
  });
});
