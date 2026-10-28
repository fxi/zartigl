import { vi } from "vitest";
import type { GeoVideoManifest } from "./geovideo";
import { fakeWebGL2 } from "./test-webgl2";

export const scalarManifest: GeoVideoManifest = {
  schemaVersion: 3,
  id: "1c21d5ae-ee20-47aa-aec0-30e69506bc9b",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -90, 180, 90],
  media: {
    url: "values.mp4",
    mimeType: "video/mp4",
    width: 16,
    height: 8,
    fps: 24,
    durationSeconds: 0.5,
    codec: "h264",
  },
  encoding: {
    kind: "scalar-luma",
    bits: 8,
    codeMin: 8,
    codeMax: 247,
    valueMin: -3,
    valueMax: 3,
    transfer: "linear",
    colorSpace: "bt709",
    colorRange: "limited",
  },
  mask: {
    kind: "static-validity",
    url: "mask.png",
    mimeType: "image/png",
    width: 16,
    height: 8,
    threshold: 0.5,
  },
  timeline: {
    kind: "sample-sequence",
    values: Array.from({ length: 12 }, (_, i) =>
      new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    ),
  },
  provenance: {
    catalogEntryId: "3db0120b-17d2-4789-9952-efcc0953ecc4",
    inputSourceId: "e18cff03-d2a3-4a41-bfd8-b4ea62bca2a3",
    identifiers: { dataset: "test" },
    variables: ["test"],
    generatedAt: "2026-07-02T00:00:00Z",
  },
  style: { palette: "balance", colorDomain: [-3, 3] },
};

/** GL calls with distinct constants, texture identities and recorded uploads. */
export function geoVideoTestGl() {
  let textureId = 0;
  const calls = {
    createTexture: vi.fn(() => ({ id: textureId++ })),
    createBuffer: vi.fn(() => ({})),
    texImage2D: vi.fn(),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    uniform1f: vi.fn(),
    drawElements: vi.fn(),
    getUniformLocation: vi.fn((_program: unknown, name: string) => name),
    getParameter: vi.fn((name: number): unknown => {
      if (name === constants.MAX_TEXTURE_SIZE) {
        return 8192;
      }
      if (name === constants.VIEWPORT) {
        return [0, 0, 800, 600];
      }
      if (name === constants.UNPACK_ALIGNMENT) {
        return 4;
      }
      return 0;
    }),
  };
  const constants: Record<string, number> = {
    TEXTURE0: 100,
    TEXTURE1: 101,
    TEXTURE2: 102,
    TEXTURE3: 103,
  };
  let next = 200;
  const gl = fakeWebGL2(
    new Proxy(calls, {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) {
          return (constants[prop] ??= next++);
        }
        return () => null;
      },
    }),
  );
  return { gl, calls };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain frame request/upload/seek completion microtasks. */
export async function flushFrames(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
