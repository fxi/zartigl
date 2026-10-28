import { describe, expect, it, vi } from "vitest";
import {
  GeoVideoScalarSource,
  geoVideoScalarUniforms,
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

describe("geoVideoScalarUniforms", () => {
  it("gives the codes as red channel fractions, as the frame decodes", () => {
    // The codes are gray RGB: limited range does not shift them.
    expect(geoVideoScalarUniforms(encoding)).toEqual({
      codeRange: [8 / 255, 247 / 255],
      valueRange: [-2, 30],
      transfer: 0,
    });
  });

  it("flags codes stored at log10(1 + 9t)", () => {
    expect(
      geoVideoScalarUniforms({ ...encoding, transfer: "log10-1p9" }).transfer,
    ).toBe(1);
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

  it("keeps the presented frame as an image, never read back", async () => {
    const source = new GeoVideoScalarSource(manifest);
    const internals = source as unknown as {
      isBlank(video: unknown): boolean;
      readCodes(video: unknown, rows: number): Uint8Array | null;
      capture(video: unknown, rows: number, mask: Uint8Array): Promise<unknown>;
    };
    const video = {};
    const bitmap = { width: 4, height: 2 };
    const create = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal("createImageBitmap", create);
    try {
      vi.spyOn(internals, "isBlank").mockReturnValue(false);
      const readCodes = vi.spyOn(internals, "readCodes");
      expect(await internals.capture(video, 2, new Uint8Array(8))).toBe(bitmap);
      expect(create).toHaveBeenCalledWith(video, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      expect(readCodes).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a blank decoder so the source can prime it", async () => {
    const source = new GeoVideoScalarSource(manifest);
    const internals = source as unknown as {
      isBlank(video: unknown): boolean;
      capture(video: unknown): Promise<unknown>;
    };
    vi.spyOn(internals, "isBlank").mockReturnValue(true);
    expect(await internals.capture({})).toBeNull();
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
