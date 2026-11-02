import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeoVideoCodecScalarSource } from "./GeoVideoCodecSource";
import { GeoVideoScalarSource } from "./GeoVideoScalarSource";
import type { GeoVideoManifest } from "./geovideo";
import { mp4Fixture } from "./mp4.fixture";

const days = Array.from({ length: 7 }, (_, i) => `2026-09-0${i + 1}T00:00:00Z`);

/** The 32x16, seven-frame fixture as a daily scalar chunk. */
const manifest = {
  schemaVersion: 3,
  id: "1c21d5ae-ee20-47aa-aec0-30e69506bc9b",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -90, 180, 90],
  media: {
    url: "https://example.test/video.mp4",
    mimeType: "video/mp4",
    width: 32,
    height: 16,
    fps: 24,
    durationSeconds: 7 / 24,
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
    width: 32,
    height: 16,
    threshold: 0.5,
  },
  timeline: { kind: "sample-sequence", values: days },
  provenance: {
    catalogEntryId: "3db0120b-17d2-4789-9952-efcc0953ecc4",
    inputSourceId: "e18cff03-d2a3-4a41-bfd8-b4ea62bca2a3",
    variables: ["thetao"],
    generatedAt: "2026-10-10T00:00:00Z",
  },
  style: { palette: "thermal", colorDomain: [0, 1] },
} as GeoVideoManifest;

class FakeFrame {
  static all: FakeFrame[] = [];
  closed = false;
  constructor(readonly timestamp: number) {
    FakeFrame.all.push(this);
    FakeFrame.maxOpen = Math.max(
      FakeFrame.maxOpen,
      FakeFrame.all.filter((f) => !f.closed).length,
    );
  }
  static maxOpen = 0;
  close() {
    this.closed = true;
  }
}

/**
 * Outputs frames in display order once every earlier one of the group was
 * decoded, like a decoder's reorder buffer; flush drains it.
 */
class FakeDecoder extends EventTarget {
  static instances: FakeDecoder[] = [];
  state = "unconfigured";
  decodeQueueSize = 0;
  readonly decoded: number[] = [];
  private readonly held = new Set<number>();
  private next = -1;

  constructor(
    private readonly init: {
      output: (frame: FakeFrame) => void;
      error: (error: Error) => void;
    },
  ) {
    super();
    FakeDecoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { type: string; timestamp: number }) {
    if (this.next < 0) {
      expect(chunk.type).toBe("key");
      this.next = chunk.timestamp;
    }
    this.decoded.push(chunk.timestamp);
    this.held.add(chunk.timestamp);
    queueMicrotask(() => {
      this.dispatchEvent(new Event("dequeue"));
      this.drain(false);
    });
  }
  flush() {
    return Promise.resolve().then(() => this.drain(true));
  }
  close() {
    this.state = "closed";
  }
  private drain(all: boolean) {
    while (this.held.size) {
      const frame = this.held.has(this.next)
        ? this.next
        : all
          ? Math.min(...this.held)
          : null;
      if (frame === null) {
        return;
      }
      this.held.delete(frame);
      this.next = frame + 1;
      this.init.output(new FakeFrame(frame));
    }
  }
}

const bitmaps: number[] = [];

beforeEach(() => {
  FakeDecoder.instances = [];
  FakeFrame.all = [];
  FakeFrame.maxOpen = 0;
  bitmaps.length = 0;
  vi.stubGlobal(
    "VideoDecoder",
    Object.assign(FakeDecoder, {
      isConfigSupported: async () => ({ supported: true }),
    }),
  );
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal("createImageBitmap", async (frame: FakeFrame) => {
    bitmaps.push(frame.timestamp);
    return { frame: frame.timestamp };
  });
  vi.stubGlobal("fetch", async () => new Response(mp4Fixture()));
  vi.spyOn(
    GeoVideoScalarSource.prototype as unknown as {
      loadMask(): Promise<Uint8Array>;
    },
    "loadMask",
  ).mockResolvedValue(new Uint8Array(32 * 16).fill(255));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GeoVideoCodecScalarSource", () => {
  it("plays a chunk with one decode per sample", async () => {
    const source = new GeoVideoCodecScalarSource(manifest);
    for (let step = 0; step < 7; step++) {
      await source.frame(step);
    }
    expect(source.usesWebCodecs).toBe(true);
    expect(bitmaps).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(FakeDecoder.instances).toHaveLength(1);
    // Decode order: the fixture's B-frames come after their references.
    expect(FakeDecoder.instances[0].decoded).toEqual([0, 4, 2, 1, 3, 6, 5]);
  });

  it("restarts at the keyframe to go back", async () => {
    const source = new GeoVideoCodecScalarSource(manifest, { cacheSize: 1 });
    await source.frame(4);
    await source.frame(2);
    expect(bitmaps).toEqual([4, 2]);
    expect(FakeDecoder.instances).toHaveLength(2);
    expect(FakeDecoder.instances[0].state).toBe("closed");
  });

  it("closes the frames it skips and those it holds on release", async () => {
    const source = new GeoVideoCodecScalarSource(manifest);
    await source.frame(3);
    expect(bitmaps).toEqual([3]);
    const skipped = FakeFrame.all.filter((f) => f.timestamp <= 3);
    expect(skipped.map((f) => f.timestamp)).toEqual([0, 1, 2, 3]);
    expect(skipped.every((f) => f.closed)).toBe(true);
    source.release();
    expect(FakeFrame.all.every((f) => f.closed)).toBe(true);
    expect(FakeDecoder.instances[0].state).toBe("closed");
  });

  it("closes skipped frames before the target decodes", async () => {
    const source = new GeoVideoCodecScalarSource(manifest);
    await source.frame(6);
    // A surface-limited decoder stalls while skipped frames stay open.
    expect(FakeFrame.maxOpen).toBeLessThanOrEqual(2);
    expect(bitmaps).toEqual([6]);
  });

  it("restarts for a step skipped by a cancelled request", async () => {
    const source = new GeoVideoCodecScalarSource(manifest);
    const controller = new AbortController();
    const far = source.frame(6, { signal: controller.signal });
    controller.abort();
    await expect(far).rejects.toThrow(/cancelled/);
    await source.frame(2);
    expect(bitmaps[bitmaps.length - 1]).toBe(2);
  });

  it("falls back to seeking without WebCodecs", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    const seek = vi
      .spyOn(
        GeoVideoScalarSource.prototype as unknown as {
          loadMedia(): Promise<void>;
        },
        "loadMedia",
      )
      .mockResolvedValue(undefined);
    const source = new GeoVideoCodecScalarSource(manifest);
    await source.init();
    expect(source.usesWebCodecs).toBe(false);
    expect(seek).toHaveBeenCalledOnce();
  });

  it("falls back to seeking when the codec is unsupported", async () => {
    vi.stubGlobal(
      "VideoDecoder",
      Object.assign(FakeDecoder, {
        isConfigSupported: async () => ({ supported: false }),
      }),
    );
    const seek = vi
      .spyOn(
        GeoVideoScalarSource.prototype as unknown as {
          loadMedia(): Promise<void>;
        },
        "loadMedia",
      )
      .mockResolvedValue(undefined);
    const source = new GeoVideoCodecScalarSource(manifest);
    await source.init();
    expect(source.usesWebCodecs).toBe(false);
    expect(seek).toHaveBeenCalledOnce();
  });
});
