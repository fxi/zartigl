import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogGeoVideoSource } from "../catalog";
import type { GeoVideoIndex } from "../engine";
import { DEMO_LAYERS, layerKey, loadTintChunks, pairChunk } from "./layers";

const chunk = (start: string, end: string): CatalogGeoVideoSource => ({
  id: "source",
  type: "geovideo",
  title: { en: "Chunk" },
  temporal: { mode: "fixed", start, end },
  manifestUrl: `https://example.test/${start}/manifest.json`,
});

const tinted = DEMO_LAYERS.find((l) => l.tint)!;

describe("pairChunk", () => {
  it("pairs months sampled at different hours", () => {
    // Six-hourly currents from 00:00, daily temperature at 12:00.
    const currents = chunk("2026-09-01T00:00:00Z", "2026-09-30T18:00:00Z");
    const august = chunk("2026-08-01T12:00:00Z", "2026-08-31T12:00:00Z");
    const september = chunk("2026-09-01T12:00:00Z", "2026-09-30T12:00:00Z");
    expect(pairChunk(currents, [august, september])).toBe(september);
  });

  it("pairs a single-sample month contained in the other range", () => {
    const one = chunk("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
    const october = chunk("2026-10-01T00:00:00Z", "2026-10-11T00:00:00Z");
    expect(pairChunk(one, [october])).toBe(october);
  });

  it("returns null when no month overlaps", () => {
    const currents = chunk("2026-09-01T00:00:00Z", "2026-09-30T18:00:00Z");
    const august = chunk("2026-08-01T12:00:00Z", "2026-08-31T12:00:00Z");
    expect(pairChunk(currents, [august])).toBeNull();
  });
});

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
