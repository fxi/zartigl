import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeoVideoIndex } from "../engine";
import { DEMO_LAYERS, layerKey, loadTintChunks } from "./layers";

const tinted = DEMO_LAYERS.find((l) => l.tint)!;

describe("loadTintChunks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is empty for layers without a tint", async () => {
    const plain = DEMO_LAYERS.find((l) => !l.tint)!;
    const load = vi.fn();
    await expect(loadTintChunks(plain, load)).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("falls back to no chunks when the tint index cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(loadTintChunks(tinted, load)).resolves.toEqual([]);
  });

  it("lists the tint archive chunks", async () => {
    const load = vi.fn(
      async (): Promise<GeoVideoIndex> => ({
        schemaVersion: 1,
        type: "geovideo-index",
        catalogEntryId: tinted.tint!.entryId,
        sourceId: "1c21d5ae-ee20-47aa-aec0-30e69506bc9b",
        updatedAt: null,
        chunks: [
          {
            period: {
              start: "2026-09-01T00:00:00Z",
              end: "2026-10-01T00:00:00Z",
            },
            start: "2026-09-01T00:00:00Z",
            end: "2026-09-30T00:00:00Z",
            samples: 30,
            key: "0a8da727c742",
            manifestUrl: "0a8da727c742/manifest.json",
          },
        ],
      }),
    );
    const chunks = await loadTintChunks(tinted, load);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].temporal?.start).toBe("2026-09-01T00:00:00Z");
  });
});

describe("layerKey", () => {
  it("keeps entry ids as keys and gives shared entries their own key", () => {
    const keys = DEMO_LAYERS.map(layerKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(layerKey(DEMO_LAYERS[0])).toBe(DEMO_LAYERS[0].entryId);
  });
});
