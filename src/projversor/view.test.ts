import { describe, expect, it } from "vitest";
import { PROJECTIONS } from "./projections";
import {
  compositeBlend,
  isGlobalGrid,
  lerpInset,
  regionView,
  viewArea,
  type View,
} from "./view";

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

describe("viewArea", () => {
  it("is the whole viewport without an inset", () => {
    expect(viewArea(view)).toEqual({
      cx: 500,
      cy: 400,
      width: 1000,
      height: 800,
    });
  });

  it("centers on the free zone and never collapses", () => {
    const inset = { top: 100, right: 0, bottom: 0, left: 400 };
    expect(viewArea({ ...view, inset })).toEqual({
      cx: 700,
      cy: 450,
      width: 600,
      height: 700,
    });
    const crushed = { top: 900, right: 0, bottom: 0, left: 0 };
    expect(viewArea({ ...view, inset: crushed }).height).toBe(1);
  });

  it("fits a region to the free zone", () => {
    const inset = { top: 0, right: 0, bottom: 400, left: 0 };
    const region = regionView([-6, 30, 36, 46], { ...view, inset })!;
    const span = (42 * Math.cos((38 * Math.PI) / 180) * Math.PI) / 180;
    expect(region.zoom).toBeCloseTo((0.85 * 400) / (span * 400));
  });

  it("blends insets", () => {
    const a = { top: 0, right: 0, bottom: 0, left: 0 };
    const b = { top: 100, right: 40, bottom: 0, left: 200 };
    expect(lerpInset(a, b, 0.5)).toEqual({
      top: 50,
      right: 20,
      bottom: 0,
      left: 100,
    });
  });
});

describe("isGlobalGrid", () => {
  it("repeats global grids only", () => {
    expect(isGlobalGrid([-180, -80, 180, 90])).toBe(true);
    expect(isGlobalGrid([-179.92, -80, 180, 90])).toBe(true);
    expect(isGlobalGrid([-6, 30.19, 36.3, 45.98])).toBe(false);
  });
});

describe("compositeBlend", () => {
  it("keeps alpha as coverage on the premultiplied canvas", () => {
    const calls: number[][] = [];
    const gl = {
      SRC_ALPHA: 1,
      ONE_MINUS_SRC_ALPHA: 2,
      ONE: 3,
      blendFuncSeparate: (...args: number[]) => calls.push(args),
    };
    compositeBlend(gl as unknown as WebGL2RenderingContext);
    // Alpha must not be squared (SRC_ALPHA on alpha darkened faded trails).
    expect(calls).toEqual([[1, 2, 3, 2]]);
  });
});
