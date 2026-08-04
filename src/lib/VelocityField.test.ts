import { describe, expect, it, vi } from "vitest";
import { VelocityField } from "./VelocityField";
import type { VelocityData } from "./types";

function scalarData(values: number[], min: number, max: number): VelocityData {
  return {
    u: new Float32Array(values),
    v: new Float32Array(values.length),
    width: values.length,
    height: 1,
    uMin: min,
    uMax: max,
    vMin: 0,
    vMax: 0,
    bounds: { west: 0, south: 0, east: values.length, north: 1 },
    scalarMode: true,
  };
}

function encodedRedValues(
  data: VelocityData,
  colorDomain: [number, number] | null = null,
): number[] {
  let uploaded: Uint8Array | undefined;
  const gl = {
    TEXTURE_2D: 0x0de1,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    UNPACK_ALIGNMENT: 0x0cf5,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    pixelStorei: () => undefined,
    texImage2D: (...args: unknown[]) => {
      uploaded = args[8] as Uint8Array;
    },
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const field = new VelocityField();
  field.init(gl as unknown as WebGLRenderingContext);
  try {
    field.update(data, colorDomain);
  } finally {
    logSpy.mockRestore();
  }
  return Array.from({ length: data.width }, (_, index) => uploaded![index * 4]);
}

describe("VelocityField scalar color encoding", () => {
  it("retains the full texture range for large-offset automatic and fixed domains", () => {
    expect(encodedRedValues(scalarData([273, 273.5, 274], 273, 274)))
      .toEqual([0, 128, 255]);
    expect(encodedRedValues(scalarData([273, 273.5, 274], 270, 280), [273, 274]))
      .toEqual([0, 128, 255]);
  });

  it("applies fixed domains and clamps out-of-range values on the CPU", () => {
    expect(encodedRedValues(scalarData([-4, 0, 4], -4, 4), [-3, 3]))
      .toEqual([0, 128, 255]);
  });

  it("gives constant frames a defined palette coordinate", () => {
    expect(encodedRedValues(scalarData([0], 0, 0), [-3, 3])).toEqual([128]);
    expect(encodedRedValues(scalarData([273], 273, 273))).toEqual([0]);
  });
});
