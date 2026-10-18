import { describe, expect, it, vi } from "vitest";
import {
  GeoVideoScalarSource,
  decodeScalarFrame,
  decodeScalarValue,
} from "./GeoVideoScalarSource";
import type { GeoVideoManifest, GeoVideoScalarEncoding } from "./geovideo";

const encoding: GeoVideoScalarEncoding = {
  kind: "scalar-luma",
  bits: 8,
  codeMin: 8,
  codeMax: 247,
  valueMin: -2,
  valueMax: 30,
  transfer: "linear",
  colorSpace: "bt709",
  colorRange: "limited",
};

const manifest: GeoVideoManifest = {
  schemaVersion: 3,
  id: "1c21d5ae-ee20-47aa-aec0-30e69506bc9b",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -80, 180, 90],
  media: {
    url: "https://example.test/video.mp4",
    mimeType: "video/mp4",
    width: 4,
    height: 2,
    fps: 24,
    durationSeconds: 0.125,
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
    values: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
  },
  provenance: {
    catalogEntryId: "3db0120b-17d2-4789-9952-efcc0953ecc4",
    inputSourceId: "e18cff03-d2a3-4a41-bfd8-b4ea62bca2a3",
    variables: ["thetao"],
    generatedAt: "2026-10-10T00:00:00Z",
  },
  style: { palette: "thermal", colorDomain: [-2, 30], unit: "degrees_C" },
};

describe("scalar-luma decoding", () => {
  it("maps the code range linearly onto the value range, clamped", () => {
    expect(decodeScalarValue(8, encoding)).toBe(-2);
    expect(decodeScalarValue(247, encoding)).toBe(30);
    expect(decodeScalarValue(127.5, encoding)).toBeCloseTo(14, 9);
    expect(decodeScalarValue(0, encoding)).toBe(-2);
    expect(decodeScalarValue(255, encoding)).toBe(30);
  });

  it("masks invalid cells as NaN", () => {
    const values = decodeScalarFrame(
      new Uint8Array([8, 247, 8, 247]),
      new Uint8Array([255, 255, 0, 127]),
      0.5,
      encoding,
    );
    expect(Array.from(values)).toEqual([-2, 30, NaN, NaN]);
  });

  it("rejects frames whose size does not match the mask", () => {
    expect(() =>
      decodeScalarFrame(new Uint8Array(3), new Uint8Array(4), 0.5, encoding),
    ).toThrow(/expected 4/);
  });
});

describe("GeoVideoScalarSource", () => {
  it("reads one plane per frame", () => {
    const source = new GeoVideoScalarSource(manifest);
    expect([source.width, source.height]).toEqual([4, 2]);
  });

  it("rejects vector manifests", () => {
    expect(
      () =>
        new GeoVideoScalarSource({
          ...manifest,
          encoding: {
            kind: "vector-luma",
            bits: 8,
            codeMin: 16,
            codeMax: 235,
            valueDomain: 1,
            transfer: "sqrt",
            layout: "stacked-uv",
            colorSpace: "bt709",
            colorRange: "limited",
          },
        }),
    ).toThrow(/scalar-luma/);
  });

  it("catches a frame presented before the seek completes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
    try {
      // The browser presents the sought frame before it fires `seeked`.
      const callbacks: (() => void)[] = [];
      const video = Object.assign(new EventTarget(), {
        seeking: false,
        readyState: 4,
        requestVideoFrameCallback(callback: () => void) {
          callbacks.push(callback);
        },
      });
      Object.defineProperty(video, "currentTime", {
        get: () => 0,
        set() {
          callbacks.splice(0).forEach((callback) => callback());
          queueMicrotask(() => video.dispatchEvent(new Event("seeked")));
        },
      });
      const source = new GeoVideoScalarSource(manifest);
      let done = false;
      void (
        source as unknown as {
          presentFrame(video: unknown, seconds: number): Promise<void>;
        }
      )
        .presentFrame(video, 0.0625)
        .then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("decodes each frame once and serves it from the cache", async () => {
    const source = new GeoVideoScalarSource(manifest);
    const values = new Float32Array([1, 2, 3, 4]);
    const decode = vi
      .spyOn(source as unknown as { decode(): Promise<unknown> }, "decode")
      .mockResolvedValue(values);
    expect(await source.frame(1)).toBe(values);
    expect(await source.frame(1)).toBe(values);
    expect(decode).toHaveBeenCalledOnce();
  });
});
