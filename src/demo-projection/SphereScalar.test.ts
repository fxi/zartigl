import { describe, expect, it } from "vitest";
import { gridCells } from "./SphereScalar";

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
