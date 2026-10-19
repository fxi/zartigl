import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog, type CatalogEntry } from "../catalog";
import { isGeoVideoArchiveSource, type GeoVideoIndex } from "../engine";
import {
  PROJVERSOR_LAYERS,
  PARTICLE_PALETTES,
  TINT_LAYERS,
  catalogLayers,
  findLayer,
  layerPalettes,
  loadTintChunks,
} from "./layers";

const tinted = PROJVERSOR_LAYERS.find((l) => l.tint)!;

describe("catalogLayers", () => {
  it("lists every catalog entry with a GeoVideo archive", () => {
    const archived = catalog.layers.filter((e) =>
      e.sources.some(isGeoVideoArchiveSource),
    );
    const entryIds = new Set(PROJVERSOR_LAYERS.map((l) => l.entryId));
    expect(entryIds).toEqual(new Set(archived.map((e) => e.id)));
  });

  it("includes Mediterranean vectors and scalars", () => {
    expect(findLayer("med-ocean-current-velocity")?.kind).toBe("vector");
    expect(findLayer("med-sea-water-temperature")?.kind).toBe("scalar");
  });

  it("puts vector layers first, each tinted layer after its plain one", () => {
    const kinds = PROJVERSOR_LAYERS.map((l) => l.kind);
    expect(kinds.indexOf("scalar")).toBe(kinds.lastIndexOf("vector") + 1);
    const plain = PROJVERSOR_LAYERS.findIndex(
      (l) => l.id === "ocean-current-velocity",
    );
    expect(PROJVERSOR_LAYERS[plain + 1].id).toBe("ocean-velocity-temperature");
  });

  it("gives every layer a unique key", () => {
    const keys = PROJVERSOR_LAYERS.map((l) => l.id);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tints only with scalar layers", () => {
    const scalars = new Set(TINT_LAYERS.map((l) => l.entryId));
    for (const layer of PROJVERSOR_LAYERS.filter((l) => l.tint)) {
      expect(layer.kind).toBe("vector");
      expect(scalars.has(layer.tint!)).toBe(true);
    }
  });

  it("styles particles with speed palettes, rasters with the catalog's", () => {
    for (const layer of PROJVERSOR_LAYERS) {
      expect(layerPalettes(layer).some((p) => p.id === layer.palette)).toBe(
        true,
      );
    }
    expect(findLayer("ocean-current-velocity")?.palette).toBe("plasma");
    const sst = catalog.layers.find(
      (e) => e.aliases?.[0] === "sea-water-temperature",
    )!;
    expect(findLayer("sea-water-temperature")?.palette).toBe(
      sst.defaults.palette,
    );
    expect(PARTICLE_PALETTES.some((p) => p.tags.includes("diverging"))).toBe(
      false,
    );
  });

  it("skips entries without an archive and keys by id without alias", () => {
    const [entry] = catalog.layers;
    const bare: CatalogEntry = { ...entry, aliases: undefined };
    const noArchive: CatalogEntry = {
      ...entry,
      id: "no-archive",
      sources: entry.sources.filter((s) => !isGeoVideoArchiveSource(s)),
    };
    expect(catalogLayers([bare, noArchive]).map((l) => l.id)).toEqual([
      entry.id,
    ]);
  });
});

describe("findLayer", () => {
  it("finds layers by key and by the entry id older links carry", () => {
    expect(findLayer("ocean-velocity-temperature")).toBe(tinted);
    expect(findLayer(tinted.entryId)?.id).toBe("ocean-current-velocity");
    expect(findLayer("nope")).toBeUndefined();
  });
});

describe("loadTintChunks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is empty without a tint", async () => {
    const load = vi.fn();
    await expect(loadTintChunks(null, load)).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("falls back to no chunks when the tint index cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(loadTintChunks(tinted.tint, load)).resolves.toEqual([]);
  });

  it("lists the tint archive chunks", async () => {
    const load = vi.fn(
      async (): Promise<GeoVideoIndex> => ({
        schemaVersion: 1,
        type: "geovideo-index",
        catalogEntryId: tinted.tint!,
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
    const chunks = await loadTintChunks(tinted.tint, load);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].temporal?.start).toBe("2026-09-01T00:00:00Z");
  });
});
