import { describe, expect, it, vi } from "vitest";
import {
  GeoVideoArchiveSource,
  createGeoVideoFrameSource,
  geoVideoGrid,
  nextChunkSpan,
  pairChunkSpan,
  type GeoVideoArchiveChunk,
  type GeoVideoFrameData,
} from "./GeoVideoArchiveSource";
import type { GeoVideoManifest } from "./geovideo";
import { geoVideoIndexChunks, type GeoVideoIndex } from "./geovideo-index";
import { GeoVideoVectorSource } from "./GeoVideoVectorSource";

const ms = (iso: string) => Date.parse(iso);
const day = 86_400_000;

function manifest(
  values: string[],
  kind: "scalar-luma" | "vector-luma" = "scalar-luma",
): GeoVideoManifest {
  return {
    schemaVersion: 3,
    id: "1c21d5ae-ee20-47aa-aec0-30e69506bc9b",
    type: "geovideo",
    projection: "equirectangular",
    bounds: [-180, -90, 180, 90],
    media: {
      url: `https://example.test/${values[0]}.mp4`,
      mimeType: "video/mp4",
      width: 2,
      height: kind === "vector-luma" ? 2 : 1,
      fps: 24,
      durationSeconds: values.length / 24,
      codec: "h264",
    },
    encoding:
      kind === "vector-luma"
        ? {
            kind,
            bits: 8,
            codeMin: 16,
            codeMax: 235,
            valueDomain: 1,
            transfer: "linear",
            layout: "stacked-uv",
            colorSpace: "bt709",
            colorRange: "limited",
          }
        : {
            kind,
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
    timeline: { kind: "sample-sequence", values },
    provenance: {
      catalogEntryId: "3db0120b-17d2-4789-9952-efcc0953ecc4",
      inputSourceId: "e18cff03-d2a3-4a41-bfd8-b4ea62bca2a3",
      variables: ["thetao"],
      generatedAt: "2026-10-10T00:00:00Z",
    },
    style: { palette: "thermal", colorDomain: [0, 1] },
  };
}

/** Daily steps from `first` to `last` (ISO dates). */
function daily(first: string, last: string): string[] {
  const values: string[] = [];
  for (let t = ms(first); t <= ms(last); t += day) {
    values.push(new Date(t).toISOString());
  }
  return values;
}

interface Fixture {
  key: string;
  values: string[];
}

const august: Fixture = {
  key: "aug",
  values: daily("2026-08-29T00:00:00Z", "2026-08-31T00:00:00Z"),
};
const september: Fixture = {
  key: "sep",
  values: daily("2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z"),
};
const october: Fixture = {
  key: "oct",
  values: daily("2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z"),
};

function chunkOf({ key, values }: Fixture): GeoVideoArchiveChunk {
  return {
    key,
    manifestUrl: `https://example.test/${key}/manifest.json`,
    start: ms(values[0]),
    end: ms(values[values.length - 1]),
  };
}

interface Decode {
  chunk: string;
  index: number;
  signal: AbortSignal;
  resolve: () => void;
}

/**
 * An archive over real frame sources whose decoder is faked: each decode
 * yields a frame filled with its step time, settled immediately or, with
 * `manual`, when the test resolves it.
 */
function archive(
  fixtures: Fixture[],
  options: {
    manual?: boolean;
    maxOpenChunks?: number;
    maxGap?: number;
    kind?: "scalar-luma" | "vector-luma";
  } = {},
) {
  const manifests = new Map(
    fixtures.map((fixture) => [
      chunkOf(fixture).manifestUrl,
      { key: fixture.key, manifest: manifest(fixture.values, options.kind) },
    ]),
  );
  const decodes: Decode[] = [];
  const released: string[] = [];
  const opened: string[] = [];
  const loadManifest = vi.fn(
    async (url: string) => manifests.get(url)!.manifest,
  );
  const source = new GeoVideoArchiveSource<GeoVideoFrameData>({
    id: "archive",
    chunks: fixtures.map(chunkOf),
    maxOpenChunks: options.maxOpenChunks,
    maxGap: options.maxGap,
    loadManifest,
    createFrameSource(m, sourceOptions) {
      const key = [...manifests.values()].find((v) => v.manifest === m)!.key;
      opened.push(key);
      const frames = createGeoVideoFrameSource(m, sourceOptions);
      const times =
        m.timeline.kind === "sample-sequence" ? m.timeline.values : [];
      vi.spyOn(
        frames as unknown as {
          decode(index: number, signal: AbortSignal): Promise<unknown>;
        },
        "decode",
      ).mockImplementation((index, signal) => {
        const value = ms(times[index]);
        const data =
          frames instanceof GeoVideoVectorSource
            ? { u: new Float32Array([value]), v: new Float32Array([-value]) }
            : new Float32Array([value]);
        return new Promise((resolve) => {
          const decode = {
            chunk: key,
            index,
            signal,
            resolve: () => resolve(data),
          };
          decodes.push(decode);
          if (!options.manual) {
            decode.resolve();
          }
        });
      });
      const release = frames.release.bind(frames);
      frames.release = () => {
        released.push(key);
        release();
      };
      return frames;
    },
  });
  return { source, decodes, released, opened, loadManifest };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GeoVideoArchiveSource timeline", () => {
  it("spans every chunk, sorted", () => {
    const { source } = archive([september, august]);
    expect(source.chunks.map((chunk) => chunk.key)).toEqual(["aug", "sep"]);
    expect(source.range).toEqual([
      ms("2026-08-29T00:00:00Z"),
      ms("2026-09-03T00:00:00Z"),
    ]);
    expect(source.chunkAt(ms("2026-09-02T00:00:00Z"))?.key).toBe("sep");
    expect(source.chunkAt(ms("2026-08-31T12:00:00Z"))).toBeNull();
  });

  it("lists the steps of all chunks", async () => {
    const { source } = archive([august, september]);
    const steps = await source.steps();
    expect(Array.from(steps)).toEqual(
      [...august.values, ...september.values].map(ms),
    );
  });

  it("interpolates between steps of one chunk", async () => {
    const { source } = archive([august, september]);
    const time = ms("2026-09-01T06:00:00Z");
    const sample = await source.sample(time);
    expect(sample?.a.key).toBe("archive/sep/0");
    expect(sample?.b.key).toBe("archive/sep/1");
    expect(sample?.mix).toBeCloseTo(0.25, 9);
    expect(sample?.a.data).toEqual(new Float32Array([ms(september.values[0])]));
    expect(sample?.a.grid).toEqual({
      width: 2,
      height: 1,
      bounds: [-180, -90, 180, 90],
      rowOrder: "north-to-south",
    });
  });

  it("brackets across a month boundary", async () => {
    const { source } = archive([august, september]);
    const sample = await source.sample(ms("2026-08-31T18:00:00Z"));
    expect(sample?.a.key).toBe("archive/aug/2");
    expect(sample?.b.key).toBe("archive/sep/0");
    expect(sample?.a.time).toBe(ms("2026-08-31T00:00:00Z"));
    expect(sample?.b.time).toBe(ms("2026-09-01T00:00:00Z"));
    expect(sample?.mix).toBeCloseTo(0.75, 9);
  });

  it("holds the last step at or before the time in discrete mode", async () => {
    const { source, decodes } = archive([august, september]);
    const inside = await source.sample(ms("2026-09-01T23:00:00Z"), {
      mode: "discrete",
    });
    expect([inside?.a.key, inside?.b.key, inside?.mix]).toEqual([
      "archive/sep/0",
      "archive/sep/0",
      0,
    ]);
    const across = await source.sample(ms("2026-08-31T18:00:00Z"), {
      mode: "discrete",
    });
    expect([across?.a.key, across?.b.key, across?.mix]).toEqual([
      "archive/aug/2",
      "archive/aug/2",
      0,
    ]);
    // One decode per distinct frame.
    expect(decodes.map((d) => `${d.chunk}/${d.index}`)).toEqual([
      "sep/0",
      "aug/2",
    ]);
  });

  it("decodes a single frame on a step", async () => {
    const { source, decodes } = archive([august, september]);
    const sample = await source.sample(ms("2026-09-02T00:00:00Z"));
    expect(sample?.a).toBe(sample?.b);
    expect(sample?.mix).toBe(0);
    expect(decodes).toHaveLength(1);
  });

  it("is out of coverage before the first and after the last step", async () => {
    const { source, loadManifest } = archive([august, september]);
    expect(await source.sample(ms("2026-08-28T00:00:00Z"))).toBeNull();
    expect(loadManifest).not.toHaveBeenCalled();
    expect(await source.sample(ms("2026-09-03T00:00:01Z"))).toBeNull();
    expect(
      await source.sample(ms("2026-09-04T00:00:00Z"), { mode: "discrete" }),
    ).toBeNull();
  });

  it("does not bridge a missing month", async () => {
    const { source } = archive([august, october]);
    expect(await source.sample(ms("2026-09-15T00:00:00Z"))).toBeNull();
    expect(
      await source.sample(ms("2026-09-15T00:00:00Z"), { mode: "discrete" }),
    ).toBeNull();
    // Steps on both sides of the gap stay covered.
    expect(await source.sample(ms("2026-08-30T12:00:00Z"))).not.toBeNull();
    expect(await source.sample(ms("2026-10-01T12:00:00Z"))).not.toBeNull();
    const bridged = archive([august, october], { maxGap: 40 * day }).source;
    const sample = await bridged.sample(ms("2026-09-15T12:00:00Z"));
    expect([sample?.a.key, sample?.b.key]).toEqual([
      "archive/aug/2",
      "archive/oct/0",
    ]);
    expect(sample?.mix).toBeCloseTo(0.5, 9);
  });

  it("does not bridge single-step chunks without an explicit maxGap", async () => {
    const one = (key: string, iso: string): Fixture => ({ key, values: [iso] });
    const chunks = [
      one("aug", "2026-08-16T00:00:00Z"),
      one("sep", "2026-09-16T00:00:00Z"),
    ];
    const time = ms("2026-09-01T00:00:00Z");
    expect(await archive(chunks).source.sample(time)).toBeNull();
    const bridged = await archive(chunks, { maxGap: 40 * day }).source.sample(
      time,
    );
    expect([bridged?.a.key, bridged?.b.key]).toEqual([
      "archive/aug/0",
      "archive/sep/0",
    ]);
  });

  it("decodes vector frames as u/v planes", async () => {
    const { source } = archive([september], { kind: "vector-luma" });
    const sample = await source.sample(ms("2026-09-02T00:00:00Z"));
    const value = ms("2026-09-02T00:00:00Z");
    expect(sample?.a.data).toEqual({
      u: new Float32Array([value]),
      v: new Float32Array([-value]),
    });
    expect(sample?.a.grid.height).toBe(1);
  });
});

describe("GeoVideoArchiveSource prefetch and cache", () => {
  it("opens the next chunk past the prefetch point", async () => {
    const { source, decodes } = archive([august, september, october]);
    await source.sample(ms("2026-08-30T00:00:00Z"));
    await flush();
    expect(decodes.map((d) => d.chunk)).toEqual(["aug"]);
    await source.sample(ms("2026-08-30T12:00:00Z"));
    await flush();
    expect(decodes.map((d) => `${d.chunk}/${d.index}`)).toContain("sep/0");
  });

  it("releases the least recently used chunk beyond the bound", async () => {
    const { source, released } = archive([august, september, october], {
      maxOpenChunks: 2,
    });
    await source.sample(ms("2026-08-30T12:00:00Z"));
    await flush();
    expect(released).toEqual([]);
    await source.sample(ms("2026-09-02T12:00:00Z"));
    await flush();
    // October is prefetched; August, used least recently, is released.
    expect(released).toEqual(["aug"]);
    source.release();
    expect(released.sort()).toEqual(["aug", "oct", "sep"]);
  });

  it("aborts a prefetch decode when its chunk is evicted", async () => {
    const { source, decodes } = archive([august, september, october], {
      manual: true,
      maxOpenChunks: 2,
    });
    const first = source.sample(ms("2026-08-31T00:00:00Z"));
    await flush();
    decodes[0].resolve();
    await first;
    await flush();
    const prefetch = decodes.find((d) => d.chunk === "sep");
    expect(prefetch?.signal.aborted).toBe(false);
    source.release();
    expect(prefetch?.signal.aborted).toBe(true);
  });
});

describe("GeoVideoArchiveSource open-chunk bound", () => {
  it("keeps the bound while playing through many chunks", async () => {
    const months = Array.from({ length: 5 }, (_, i): Fixture => {
      const first = Date.UTC(2026, i, 1);
      return {
        key: `m${i}`,
        values: [0, 1, 2].map((d) => new Date(first + d * day).toISOString()),
      };
    });
    const { source, opened, released } = archive(months, {
      maxOpenChunks: 2,
    });
    for (const month of months) {
      // Past the prefetch point: the next month is opened ahead.
      await source.sample(ms(month.values[2]) - day / 2);
      await flush();
      expect(opened.length - released.length).toBeLessThanOrEqual(2);
    }
    expect(opened).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(released).toEqual(["m0", "m1", "m2"]);
  });
});

describe("GeoVideoArchiveSource abort", () => {
  it("isolates two consumers of the same archive", async () => {
    const { source, decodes } = archive([august, september], {
      manual: true,
    });
    const time = ms("2026-08-31T12:00:00Z");
    const first = new AbortController();
    const abandoned = source.sample(time, { signal: first.signal });
    const kept = source.sample(time, { signal: new AbortController().signal });
    await flush();
    first.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    for (const decode of decodes) {
      expect(decode.signal.aborted).toBe(false);
      decode.resolve();
    }
    await flush();
    for (const decode of decodes.slice(2)) {
      decode.resolve();
    }
    const sample = await kept;
    expect([sample?.a.key, sample?.b.key]).toEqual([
      "archive/aug/2",
      "archive/sep/0",
    ]);
    // Both consumers shared one decode per frame.
    expect(
      decodes.filter((d) => !d.signal.aborted).map((d) => d.chunk),
    ).toEqual(expect.arrayContaining(["aug", "sep"]));
    expect(
      decodes.filter((d) => d.chunk === "aug" && d.index === 2),
    ).toHaveLength(1);
  });

  it("drops the decodes of an abandoned sample", async () => {
    const { source, decodes } = archive([august, september], {
      manual: true,
    });
    const controller = new AbortController();
    const request = source.sample(ms("2026-09-01T12:00:00Z"), {
      signal: controller.signal,
    });
    await flush();
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(decodes.every((d) => d.signal.aborted)).toBe(true);
  });

  it("lists no steps for an already aborted request", async () => {
    const { source, loadManifest } = archive([august, september]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      source.steps({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it("rejects an already aborted request", async () => {
    const { source, loadManifest } = archive([august]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      source.sample(ms("2026-08-30T00:00:00Z"), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(loadManifest).not.toHaveBeenCalled();
  });
});

describe("neutral chunk helpers", () => {
  const span = (start: string, end: string) => ({
    start: ms(start),
    end: ms(end),
  });

  it("pairs vector and scalar chunks of mismatched cadence", () => {
    // Six-hourly currents from 00:00, daily temperature at 12:00.
    const currents = span("2026-09-01T00:00:00Z", "2026-09-30T18:00:00Z");
    const temperature = [
      span("2026-08-01T12:00:00Z", "2026-08-31T12:00:00Z"),
      span("2026-09-01T12:00:00Z", "2026-09-30T12:00:00Z"),
    ];
    expect(pairChunkSpan(currents, temperature)).toBe(temperature[1]);
    expect(
      pairChunkSpan(
        span("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"),
        temperature,
      ),
    ).toBeNull();
  });

  it("follows the chunk ending at a time, looping inside a range", () => {
    const chunks = [
      span("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z"),
      span("2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z"),
    ];
    expect(nextChunkSpan(chunks, chunks[1].end)?.chunk).toBe(chunks[0]);
    expect(nextChunkSpan(chunks, chunks[0].end)).toBeNull();
    expect(nextChunkSpan(chunks, chunks[0].end, { loop: true })).toEqual({
      chunk: chunks[1],
      time: chunks[1].start,
    });
  });

  it("reads index chunks as neutral descriptors", () => {
    const index: GeoVideoIndex = {
      schemaVersion: 1,
      type: "geovideo-index",
      catalogEntryId: "entry",
      sourceId: "source",
      updatedAt: null,
      chunks: [
        {
          period: {
            start: "2026-09-01T00:00:00Z",
            end: "2026-10-01T00:00:00Z",
          },
          start: "2026-09-01T00:00:00Z",
          end: "2026-09-30T18:00:00Z",
          samples: 120,
          key: "k1",
          manifestUrl: "2026-09/manifest.json",
          provisional: true,
        },
      ],
    };
    expect(
      geoVideoIndexChunks(index, "https://example.test/archive/index.json"),
    ).toEqual([
      {
        key: "k1",
        manifestUrl: "https://example.test/archive/2026-09/manifest.json",
        start: ms("2026-09-01T00:00:00Z"),
        end: ms("2026-09-30T18:00:00Z"),
        samples: 120,
        provisional: true,
      },
    ]);
  });

  it("describes the grid as cell edges, north row first", () => {
    const grid = geoVideoGrid({
      ...manifest(["2026-09-01T00:00:00Z"]),
      bounds: [170, -10, -170, 10],
    });
    expect(grid).toEqual({
      width: 2,
      height: 1,
      bounds: [170, -10, -170, 10],
      rowOrder: "north-to-south",
    });
  });
});
