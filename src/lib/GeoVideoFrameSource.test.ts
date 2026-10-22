import { describe, expect, it, vi } from "vitest";
import { abortable } from "./GeoVideoFrameSource";
import { GeoVideoScalarSource } from "./GeoVideoScalarSource";
import type { GeoVideoManifest } from "./geovideo";

const manifest = {
  schemaVersion: 3,
  id: "1c21d5ae-ee20-47aa-aec0-30e69506bc9b",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -90, 180, 90],
  media: {
    url: "https://example.test/video.mp4",
    mimeType: "video/mp4",
    width: 2,
    height: 1,
    fps: 24,
    durationSeconds: 0.25,
    codec: "h264",
  },
  encoding: {
    kind: "scalar-luma",
    bits: 8,
    codeMin: 16,
    codeMax: 235,
    valueMin: 0,
    valueMax: 1,
    transfer: "linear",
    colorSpace: "bt709",
    colorRange: "limited",
  },
  mask: {
    kind: "static-validity",
    url: "https://example.test/mask.png",
    mimeType: "image/png",
    width: 2,
    height: 1,
    threshold: 0.5,
  },
  timeline: {
    kind: "sample-sequence",
    values: [
      "2026-09-01T00:00:00Z",
      "2026-09-02T00:00:00Z",
      "2026-09-03T00:00:00Z",
    ],
  },
  provenance: {
    catalogEntryId: "3db0120b-17d2-4789-9952-efcc0953ecc4",
    inputSourceId: "e18cff03-d2a3-4a41-bfd8-b4ea62bca2a3",
    variables: ["thetao"],
    generatedAt: "2026-10-10T00:00:00Z",
  },
  style: { palette: "thermal", colorDomain: [0, 1] },
} as GeoVideoManifest;

interface Decode {
  index: number;
  signal: AbortSignal;
  resolve: (value: Float32Array) => void;
}

/** A source whose decodes settle when the test resolves them. */
function source(cacheSize = 3) {
  const target = new GeoVideoScalarSource(manifest, { cacheSize });
  const decodes: Decode[] = [];
  const decode = vi
    .spyOn(
      target as unknown as {
        decode(index: number, signal: AbortSignal): Promise<Float32Array>;
      },
      "decode",
    )
    .mockImplementation(
      (index, signal) =>
        new Promise<Float32Array>((resolve) =>
          decodes.push({ index, signal, resolve }),
        ),
    );
  return { target, decodes, decode };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const frameOf = (value: number) => new Float32Array([value, value]);

describe("GeoVideoFrameSource per-request abort", () => {
  it("keeps decoding for the request left when another aborts", async () => {
    const { target, decodes, decode } = source();
    const first = new AbortController();
    const abandoned = target.frame(1, { signal: first.signal });
    const kept = target.frame(1, { signal: new AbortController().signal });
    await flush();
    first.abort();
    await expect(abandoned).rejects.toThrow(/cancelled/);
    expect(decodes[0].signal.aborted).toBe(false);
    decodes[0].resolve(frameOf(1));
    expect(await kept).toEqual(frameOf(1));
    expect(decode).toHaveBeenCalledOnce();
  });

  it("drops a queued decode once all its requests aborted", async () => {
    const { target, decodes, decode } = source();
    const busy = target.frame(0);
    const a = new AbortController();
    const b = new AbortController();
    const requests = [
      target.frame(2, { signal: a.signal }),
      target.frame(2, { signal: b.signal }),
    ];
    a.abort();
    b.abort();
    await Promise.all(
      requests.map((request) => expect(request).rejects.toThrow(/cancelled/)),
    );
    await flush();
    decodes[0].resolve(frameOf(0));
    await busy;
    await flush();
    // Step 2 never reached the decoder; a new request decodes it again.
    expect(decode).toHaveBeenCalledOnce();
    const again = target.frame(2);
    await flush();
    decodes[1].resolve(frameOf(2));
    expect(await again).toEqual(frameOf(2));
  });

  it("aborts a running decode without overlapping the next seek", async () => {
    const { target, decodes, decode } = source();
    const controller = new AbortController();
    const running = target.frame(0, { signal: controller.signal });
    const next = target.frame(1);
    await flush();
    controller.abort();
    await expect(running).rejects.toThrow(/cancelled/);
    expect(decodes[0].signal.aborted).toBe(true);
    await flush();
    // The seek already started completes before the next one.
    expect(decode).toHaveBeenCalledOnce();
    decodes[0].resolve(frameOf(0));
    await flush();
    expect(decode).toHaveBeenCalledTimes(2);
    decodes[1].resolve(frameOf(1));
    expect(await next).toEqual(frameOf(1));
    // The abandoned step is not cached.
    void target.frame(0);
    await flush();
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it("rejects a request aborted before it starts without decoding", async () => {
    const { target, decode } = source();
    const controller = new AbortController();
    controller.abort();
    await expect(
      target.frame(0, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    await flush();
    expect(decode).not.toHaveBeenCalled();
  });

  it("serves cache hits to any request, aborting none", async () => {
    const { target, decodes, decode } = source();
    const first = target.frame(1);
    await flush();
    decodes[0].resolve(frameOf(1));
    const frame = await first;
    const controller = new AbortController();
    const hit = target.frame(1, { signal: controller.signal });
    controller.abort();
    expect(await hit).toBe(frame);
    expect(await target.frame(1)).toBe(frame);
    expect(decode).toHaveBeenCalledOnce();
  });

  it("a request without a signal keeps a decode others abandon", async () => {
    const { target, decodes } = source();
    const kept = target.frame(1);
    const controller = new AbortController();
    const left = target.frame(1, { signal: controller.signal });
    controller.abort();
    await expect(left).rejects.toThrow(/cancelled/);
    await flush();
    decodes[0].resolve(frameOf(1));
    expect(await kept).toEqual(frameOf(1));
  });

  it("cancelAll aborts every pending request and keeps decoded frames", async () => {
    const { target, decodes } = source();
    const done = target.frame(0);
    await flush();
    decodes[0].resolve(frameOf(0));
    await done;
    const pending = [target.frame(1), target.frame(2)];
    target.cancelAll();
    await Promise.all(
      pending.map((request) => expect(request).rejects.toThrow(/cancelled/)),
    );
    expect(decodes[1]?.signal.aborted ?? true).toBe(true);
    expect(await target.frame(0)).toEqual(frameOf(0));
  });
});

/** Node process events; the browser tsconfig has no Node types. */
const nodeProcess = (
  globalThis as unknown as {
    process: {
      on(event: "unhandledRejection", listener: () => void): void;
      off(event: "unhandledRejection", listener: () => void): void;
    };
  }
).process;

describe("abortable", () => {
  it("observes the shared promise when the signal is already aborted", async () => {
    const unhandled = vi.fn();
    nodeProcess.on("unhandledRejection", unhandled);
    try {
      const controller = new AbortController();
      controller.abort();
      const shared = Promise.reject(new Error("decode failed"));
      await expect(abortable(shared, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      nodeProcess.off("unhandledRejection", unhandled);
    }
  });

  it("rejects on abort without settling the shared promise", async () => {
    let resolve!: (value: number) => void;
    const shared = new Promise<number>((r) => (resolve = r));
    const controller = new AbortController();
    const onAbort = vi.fn();
    const request = abortable(shared, controller.signal, onAbort);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(onAbort).toHaveBeenCalledOnce();
    resolve(1);
    expect(await shared).toBe(1);
  });
});
