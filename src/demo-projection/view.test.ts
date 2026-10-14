import { describe, expect, it } from "vitest";
import { PROJECTIONS } from "./projections";
import { isGlobalGrid, regionView, type View } from "./view";

const ortho = PROJECTIONS.orthographic;
const view: View = {
  blend: { a: ortho, b: ortho, ka: 400, kb: 400, t: 0 },
  rotate: [0, 0, 0],
  zoom: 1,
  width: 1000,
  height: 800,
};

describe("regionView", () => {
  it("leaves the view of a global grid alone", () => {
    expect(regionView([-180, -80, 180, 90], view)).toBeNull();
  });

  it("centers a regional grid and fits it to the smaller side", () => {
    const region = regionView([-6, 30, 36, 46], view)!;
    expect(region.rotate).toEqual([-15, -38, 0]);
    // 42° of longitude at 38° N is wider than 16° of latitude.
    const span = (42 * Math.cos((38 * Math.PI) / 180) * Math.PI) / 180;
    expect(region.zoom).toBeCloseTo((0.85 * 800) / (span * 400));
  });
});

describe("isGlobalGrid", () => {
  it("repeats global grids only", () => {
    expect(isGlobalGrid([-180, -80, 180, 90])).toBe(true);
    expect(isGlobalGrid([-179.92, -80, 180, 90])).toBe(true);
    expect(isGlobalGrid([-6, 30.19, 36.3, 45.98])).toBe(false);
  });
});
