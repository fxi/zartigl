import { describe, expect, it } from "vitest";
import { gridCells, meshBounds } from "./SphereScalar";

describe("gridCells", () => {
  it("meshes a global grid in 2° cells", () => {
    expect(gridCells([-180, -80, 180, 90])).toEqual([180, 85]);
  });

  it("meshes a regional grid finer, down to 0.25° cells", () => {
    // Mediterranean.
    expect(gridCells([-6, 30.1875, 36.3, 45.98])).toEqual([170, 64]);
    expect(gridCells([0, 0, 10, 5])).toEqual([40, 20]);
  });
});

describe("meshBounds", () => {
  it("closes a global grid to a full turn, leaving no seam at 180°", () => {
    expect(meshBounds([-180, -80, 179.91668701171875, 90])).toEqual([
      -180, -80, 180, 90,
    ]);
  });

  it("keeps regional bounds", () => {
    const med: [number, number, number, number] = [-6, 30.19, 36.3, 45.98];
    expect(meshBounds(med)).toBe(med);
  });
});
