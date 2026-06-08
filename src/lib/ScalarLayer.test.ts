import { describe, expect, it } from "vitest";
import { ScalarLayer } from "./ScalarLayer";
import type { VelocityData } from "./types";

function layerWithData(data: VelocityData): ScalarLayer {
  const layer = new ScalarLayer({
    id: "scalar",
    source: "https://example.test/scalar.zarr",
    variable: "temperature",
    unit: "degC",
    time: Date.UTC(2026, 0, 1),
    depth: 3,
  });
  (layer as unknown as { activeData: VelocityData }).activeData = data;
  return layer;
}

function scalarData(overrides: Partial<VelocityData> = {}): VelocityData {
  return {
    u: new Float32Array([10, 11, 12, 20, 21, 22]),
    v: new Float32Array(6),
    width: 3,
    height: 2,
    uMin: 10,
    uMax: 22,
    vMin: 0,
    vMax: 0,
    bounds: { west: 0, east: 2, south: 10, north: 12 },
    scalarMode: true,
    ...overrides,
  };
}

describe("ScalarLayer point sampling", () => {
  it("samples the currently displayed scalar frame without a Zarr query", async () => {
    const layer = layerWithData(scalarData({ latDescending: true }));

    const result = await layer.samplePoint({ longitude: 1, latitude: 12 });

    expect(result.value).toBe(11);
    expect(result.longitude).toBe(1);
    expect(result.latitude).toBe(12);
    expect(result.unit).toBe("degC");
    expect(result.time).toBe(Date.UTC(2026, 0, 1));
    expect(result.depth).toBe(3);
  });

  it("respects the frame latitude order", async () => {
    const ascending = layerWithData(scalarData({ latDescending: false }));
    const descending = layerWithData(scalarData({ latDescending: true }));

    await expect(ascending.samplePoint({ longitude: 1, latitude: 12 }))
      .resolves.toMatchObject({ value: 21 });
    await expect(descending.samplePoint({ longitude: 1, latitude: 12 }))
      .resolves.toMatchObject({ value: 11 });
  });

  it("returns nodata outside the displayed frame", async () => {
    const layer = layerWithData(scalarData());

    const result = await layer.samplePoint({ longitude: 1, latitude: 20 });

    expect(result.value).toBeNaN();
  });
});
