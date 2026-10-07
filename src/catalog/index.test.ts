import { describe, expect, it } from "vitest";
import {
  catalog,
  findCatalogEntries,
  getCatalogEntry,
  pickPreferredSource,
  pickSourceByPriority,
  searchCatalog,
  sourceCoversTime,
} from "./index";
import type { CatalogEntry, CatalogSource } from "./types";

describe("catalog v2 discovery", () => {
  it("uses UUID-only identity while keeping old names searchable", () => {
    const result = searchCatalog("ocean-current-velocity")[0];
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCatalogEntry("ocean-current-velocity")).toBeUndefined();
    expect(getCatalogEntry(result.id)).toBe(result);
  });

  it("searches native dataset, variables, cadence, and source type", () => {
    expect(
      searchCatalog("cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i uo")[0].aliases,
    ).toContain("ocean-current-velocity");
    expect(searchCatalog("PT1H eastward_wind")[0].aliases).toContain(
      "surface-wind",
    );
    const withGeoVideo = catalog.layers
      .filter((entry) =>
        entry.sources.some((source) => source.type === "geovideo"),
      )
      .map((entry) => entry.id)
      .sort();
    expect(withGeoVideo.length).toBeGreaterThan(0);
    expect(
      searchCatalog("geovideo")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(withGeoVideo);
  });

  it("searches catalog and source identifiers", () => {
    const entry = catalog.layers[0];
    const source = entry.sources[0];
    expect(searchCatalog(entry.id)[0]).toBe(entry);
    expect(searchCatalog(source.id)[0]).toBe(entry);
    expect(searchCatalog("global 6-hourly physics")[0]).toBe(entry);
  });

  it("filters exact source provenance", () => {
    const results = findCatalogEntries({
      provider: "copernicus-marine",
      variableId: "sithick",
      identifiers: { product: "GLOBAL_ANALYSISFORECAST_PHY_001_024" },
    });
    expect(results).toHaveLength(1);
    expect(results[0].aliases).toContain("sea-ice-thickness");
    expect(catalog.schemaVersion).toBe(2);
  });
});

describe("pickPreferredSource", () => {
  const zarr: CatalogSource = {
    id: "s-zarr",
    type: "zarr",
    title: {},
    endpoints: { field: "x" },
    variables: { kind: "scalar", value: "v" },
  };
  const wmts: CatalogSource = {
    id: "s-wmts",
    type: "wmts",
    title: {},
    capabilitiesUrl: "x",
    layer: "l",
  };
  const geovideo: CatalogSource = {
    id: "s-geovideo",
    type: "geovideo",
    title: {},
    manifestUrl: "x",
  };

  function scalarEntry(sources: CatalogSource[]): CatalogEntry {
    return {
      id: "e",
      title: {},
      category: "c",
      kind: "scalar",
      sources,
      defaults: { sourceId: sources[0].id },
    };
  }

  it("prefers geovideo over wmts and zarr for scalar entries", () => {
    expect(pickPreferredSource(scalarEntry([zarr, wmts, geovideo])).id).toBe(
      "s-geovideo",
    );
  });

  it("prefers wmts over zarr when geovideo is unavailable", () => {
    expect(pickPreferredSource(scalarEntry([zarr, wmts])).id).toBe("s-wmts");
  });

  it("falls back to zarr when it is the only source", () => {
    expect(pickPreferredSource(scalarEntry([zarr])).id).toBe("s-zarr");
  });

  it("never resolves vector entries to wmts", () => {
    const entry: CatalogEntry = {
      id: "e",
      title: {},
      category: "c",
      kind: "vector",
      sources: [wmts, zarr],
      defaults: { sourceId: wmts.id },
    };
    expect(pickPreferredSource(entry).id).toBe("s-zarr");
  });

  const fixedVideo: CatalogSource = {
    ...geovideo,
    id: "s-fixed-video",
    temporal: {
      mode: "fixed",
      start: "2026-08-01T00:00:00Z",
      end: "2026-09-30T21:00:00Z",
    },
  };
  const at = (iso: string) => Date.parse(iso);

  it("bounds only fixed-period sources by their declared period", () => {
    expect(
      sourceCoversTime(fixedVideo, { time: at("2026-08-14T00:00:00Z") }),
    ).toBe(true);
    expect(
      sourceCoversTime(fixedVideo, { time: at("2024-12-14T00:00:00Z") }),
    ).toBe(false);
    expect(
      sourceCoversTime(fixedVideo, {
        start: at("2024-12-14T00:00:00Z"),
        end: at("2024-12-14T22:00:00Z"),
      }),
    ).toBe(false);
    expect(
      sourceCoversTime(fixedVideo, {
        start: at("2026-09-30T00:00:00Z"),
        end: at("2026-10-05T00:00:00Z"),
      }),
    ).toBe(true);
    expect(sourceCoversTime(fixedVideo)).toBe(true);
    expect(sourceCoversTime(zarr, { time: at("1990-01-01T00:00:00Z") })).toBe(
      true,
    );
  });

  it("skips a fixed-period GeoVideo that cannot show the requested time", () => {
    const vector: CatalogEntry = {
      id: "e",
      title: {},
      category: "c",
      kind: "vector",
      sources: [zarr, fixedVideo],
      defaults: { sourceId: zarr.id },
    };
    const chido = {
      start: at("2024-12-14T00:00:00Z"),
      end: at("2024-12-14T22:00:00Z"),
    };
    expect(pickPreferredSource(vector, chido).id).toBe("s-zarr");
    expect(
      pickPreferredSource(vector, { time: at("2026-08-14T00:00:00Z") }).id,
    ).toBe("s-fixed-video");
    expect(pickPreferredSource(vector).id).toBe("s-fixed-video");
    expect(
      pickPreferredSource(scalarEntry([zarr, wmts, fixedVideo]), chido).id,
    ).toBe("s-wmts");
  });

  it("chooses among several GeoVideo periods by coverage, then recency", () => {
    const olderVideo: CatalogSource = {
      ...geovideo,
      id: "s-2024-video",
      temporal: {
        mode: "fixed",
        start: "2024-11-01T00:00:00Z",
        end: "2024-12-31T23:00:00Z",
      },
    };
    const vector: CatalogEntry = {
      id: "e",
      title: {},
      category: "c",
      kind: "vector",
      sources: [zarr, olderVideo, fixedVideo],
      defaults: { sourceId: zarr.id },
    };
    expect(
      pickPreferredSource(vector, {
        start: at("2024-12-14T00:00:00Z"),
        end: at("2024-12-14T22:00:00Z"),
      }).id,
    ).toBe("s-2024-video");
    expect(
      pickPreferredSource(vector, { time: at("2026-08-14T00:00:00Z") }).id,
    ).toBe("s-fixed-video");
    expect(pickPreferredSource(vector).id).toBe("s-fixed-video");
    expect(
      pickPreferredSource(vector, { time: at("2025-06-01T00:00:00Z") }).id,
    ).toBe("s-zarr");
  });

  it("picks one source type by coverage, then recency", () => {
    const olderVideo: CatalogSource = {
      ...fixedVideo,
      id: "s-2024-video",
      temporal: {
        mode: "fixed",
        start: "2024-11-01T00:00:00Z",
        end: "2024-12-31T23:00:00Z",
      },
    };
    const entry = scalarEntry([zarr, fixedVideo, olderVideo]);
    const pick = (time?: string) =>
      pickSourceByPriority(
        entry,
        ["geovideo"],
        time ? { time: at(time) } : undefined,
      )?.id;
    expect(pick("2024-12-14T00:00:00Z")).toBe("s-2024-video");
    expect(pick("2025-06-01T00:00:00Z")).toBe("s-fixed-video");
    expect(pick()).toBe("s-fixed-video");
    expect(pickSourceByPriority(scalarEntry([zarr]), ["wmts"])).toBeUndefined();
  });

  it("prefers geovideo for vector entries and keeps zarr as fallback", () => {
    const entry: CatalogEntry = {
      id: "e",
      title: {},
      category: "c",
      kind: "vector",
      sources: [zarr, geovideo],
      defaults: { sourceId: zarr.id },
    };
    expect(pickPreferredSource(entry).id).toBe("s-geovideo");
  });
});
