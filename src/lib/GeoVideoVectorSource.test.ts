import { describe, expect, it, vi } from "vitest";
import {
  GeoVideoVectorSource,
  decodeVectorComponent,
  decodeVectorFrame,
  isBlankReadback,
  lumaCodesFromRgba,
  type GeoVideoVectorFrame,
} from "./GeoVideoVectorSource";
import type { GeoVideoManifest, GeoVideoVectorEncoding } from "./geovideo";

const encoding: GeoVideoVectorEncoding = {
  kind: "vector-luma",
  bits: 8,
  codeMin: 16,
  codeMax: 235,
  valueDomain: 2,
  transfer: "sqrt",
  layout: "stacked-uv",
  colorSpace: "bt709",
  colorRange: "limited",
};

const manifest: GeoVideoManifest = {
  schemaVersion: 3,
  id: "f5b31e02-ff0f-4310-a046-a781bd2b1c38",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -80, 180, 90],
  media: {
    url: "https://example.test/video.mp4",
    mimeType: "video/mp4",
    width: 4,
    height: 4,
    fps: 4,
    durationSeconds: 0.75,
    codec: "h264",
  },
  encoding,
  mask: {
    kind: "static-validity",
    url: "https://example.test/mask.png",
    mimeType: "image/png",
    width: 4,
    height: 2,
    threshold: 0.5,
  },
  timeline: {
    kind: "sample-sequence",
    values: [
      "2026-08-01T00:00:00Z",
      "2026-08-01T03:00:00Z",
      "2026-08-01T06:00:00Z",
    ],
  },
  provenance: {
    catalogEntryId: "bb38fd23-b0b0-4cd0-b59d-0224be3052f9",
    inputSourceId: "1feaa33a-3c1b-4bc5-abae-fdd1f2a59f23",
    variables: ["VMDR_SW1", "VHM0_SW1"],
    generatedAt: "2026-10-07T00:00:00Z",
  },
  style: { palette: "viridis", colorDomain: [0, 2 * Math.SQRT2], unit: "m" },
};

/** Inverse of decodeVectorComponent, as written by the renderer. */
function encode(value: number, transfer: "linear" | "sqrt"): number {
  let s = Math.max(-1, Math.min(1, value / encoding.valueDomain));
  if (transfer === "sqrt") {
    s = Math.sign(s) * Math.sqrt(Math.abs(s));
  }
  return Math.round(16 + ((s + 1) / 2) * 219);
}

describe("vector-luma decoding", () => {
  it("inverts the browser limited-range expansion exactly", () => {
    const codes = Uint8Array.from({ length: 220 }, (_, i) => 16 + i);
    const rgba = new Uint8Array(codes.length * 4);
    codes.forEach((code, i) => {
      const r = Math.max(
        0,
        Math.min(255, Math.round(((code - 16) * 255) / 219)),
      );
      rgba.set([r, r, r, 255], i * 4);
    });
    expect(lumaCodesFromRgba(rgba, "limited")).toEqual(codes);
    expect(lumaCodesFromRgba(rgba, "full")).toEqual(
      Uint8Array.from(codes, (_, i) => rgba[i * 4]),
    );
  });

  it("maps code endpoints and center to the domain for both transfers", () => {
    for (const transfer of ["linear", "sqrt"] as const) {
      const config = { ...encoding, transfer };
      expect(decodeVectorComponent(16, config)).toBeCloseTo(-2);
      expect(decodeVectorComponent(235, config)).toBeCloseTo(2);
      expect(decodeVectorComponent(125.5, config)).toBeCloseTo(0);
    }
  });

  it("keeps slow components more precise with the sqrt transfer", () => {
    const slow = 0.02;
    const linear = decodeVectorComponent(encode(slow, "linear"), {
      ...encoding,
      transfer: "linear",
    });
    const sqrt = decodeVectorComponent(encode(slow, "sqrt"), encoding);
    expect(Math.abs(sqrt - slow)).toBeLessThan(Math.abs(linear - slow));
  });

  it("splits stacked u/v rows and masks invalid cells", () => {
    const u = [0.5, -1, 1.5, 0];
    const v = [-0.25, 2, -2, 1];
    const codes = Uint8Array.from([
      ...u.map((x) => encode(x, "sqrt")),
      ...v.map((x) => encode(x, "sqrt")),
    ]);
    const mask = Uint8Array.from([255, 255, 0, 200]);
    const frame = decodeVectorFrame(codes, mask, 0.5, encoding);
    expect(frame.u[0]).toBeCloseTo(0.5, 1);
    expect(frame.v[1]).toBeCloseTo(2, 5);
    expect(Number.isNaN(frame.u[2])).toBe(true);
    expect(Number.isNaN(frame.v[2])).toBe(true);
    expect(frame.v[3]).toBeCloseTo(1, 1);
  });

  it("detects an all-transparent readback as a missing frame", () => {
    const blank = new Uint8Array(4 * 5000);
    expect(isBlankReadback(blank)).toBe(true);
    const frame = blank.slice();
    for (let i = 3; i < frame.length; i += 4) {
      frame[i] = 255;
    }
    expect(isBlankReadback(frame)).toBe(false);
  });

  it("rejects frames whose size does not match the mask", () => {
    expect(() =>
      decodeVectorFrame(new Uint8Array(6), new Uint8Array(4), 0.5, encoding),
    ).toThrow(/expected 8/);
  });
});

describe("GeoVideoVectorSource", () => {
  it("exposes a single full-grid chunk with cell-center coordinates", () => {
    const source = new GeoVideoVectorSource(manifest);
    const coords = source.getCoords();
    expect(source.getChunkShape()).toEqual([1, 2, 4]);
    expect(Array.from(coords.longitude)).toEqual([-135, -45, 45, 135]);
    expect(Array.from(coords.latitude)).toEqual([47.5, -37.5]);
    expect(source.getValueDomain()).toBe(2);
    expect(source.getChunksForBounds("u", 1, 0)).toEqual([
      expect.objectContaining({ timeIdx: 1, latSize: 2, lonSize: 4 }),
    ]);
  });

  it("resolves the nearest frame for a requested time", () => {
    const source = new GeoVideoVectorSource(manifest);
    expect(source.findTimeIndex("2026-08-01T00:00:00Z")).toBe(0);
    expect(source.findTimeIndex(Date.UTC(2026, 7, 1, 4))).toBe(1);
    expect(source.findTimeIndex(Date.UTC(2027, 0, 1))).toBe(2);
  });

  it("rejects scalar manifests", () => {
    expect(
      () =>
        new GeoVideoVectorSource({
          ...manifest,
          encoding: {
            kind: "scalar-luma",
            bits: 8,
            codeMin: 8,
            codeMax: 247,
            valueMin: 0,
            valueMax: 1,
            transfer: "linear",
            colorSpace: "bt709",
            colorRange: "limited",
          },
        }),
    ).toThrow(/vector-luma/);
  });

  it("decodes each frame once for u and v and serves cached frames", async () => {
    const source = new GeoVideoVectorSource(manifest);
    const frame: GeoVideoVectorFrame = {
      u: new Float32Array([1]),
      v: new Float32Array([2]),
    };
    const decode = vi
      .spyOn(source as unknown as { decode(): Promise<unknown> }, "decode")
      .mockResolvedValue(frame);
    const selection = {
      timeIndex: 1,
      verticalIndex: 0,
      latitudeChunkIndex: 0,
      longitudeChunkIndex: 0,
    };
    const [u, v] = await Promise.all([
      source.fetchSpatialChunkResult("u", selection),
      source.fetchSpatialChunkResult("v", selection),
    ]);
    expect(u.data).toBe(frame.u);
    expect(v.data).toBe(frame.v);
    await source.fetchSpatialChunkResult("u", selection);
    expect(decode).toHaveBeenCalledOnce();
  });

  it("drops failed or cancelled decodes from the cache", async () => {
    const source = new GeoVideoVectorSource(manifest);
    const decode = vi
      .spyOn(source as unknown as { decode(): Promise<unknown> }, "decode")
      .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))
      .mockResolvedValueOnce({
        u: new Float32Array([1]),
        v: new Float32Array([2]),
      });
    await expect(source.frame(0)).rejects.toThrow(/cancelled/);
    source.cancelAll();
    await expect(source.frame(0)).resolves.toBeDefined();
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("bounds the decoded frame cache", async () => {
    const source = new GeoVideoVectorSource(manifest, { cacheSize: 1 });
    const decode = vi
      .spyOn(source as unknown as { decode(): Promise<unknown> }, "decode")
      .mockImplementation(async () => ({
        u: new Float32Array(1),
        v: new Float32Array(1),
      }));
    await source.frame(0);
    await source.frame(1);
    await source.frame(0);
    expect(decode).toHaveBeenCalledTimes(3);
  });
});
