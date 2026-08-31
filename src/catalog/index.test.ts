import { describe, expect, it } from "vitest";
import { catalog, findCatalogEntries, getCatalogEntry, pickPreferredSource, searchCatalog } from "./index";
import type { CatalogEntry, CatalogSource } from "./types";

describe("catalog v2 discovery", () => {
  it("uses UUID-only identity while keeping old names searchable", () => {
    const result = searchCatalog("ocean-current-velocity")[0];
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCatalogEntry("ocean-current-velocity")).toBeUndefined();
    expect(getCatalogEntry(result.id)).toBe(result);
  });

  it("searches native dataset, variables, cadence, and source type", () => {
    expect(searchCatalog("cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i uo")[0].aliases).toContain("ocean-current-velocity");
    expect(searchCatalog("PT1H eastward_wind")[0].aliases).toContain("surface-wind");
    expect(searchCatalog("geovideo").length).toBe(3);
  });

  it("searches catalog and source identifiers", () => {
    const entry = catalog.layers[0];
    const source = entry.sources[0];
    expect(searchCatalog(entry.id)[0]).toBe(entry);
    expect(searchCatalog(source.id)[0]).toBe(entry);
    expect(searchCatalog("global 6-hourly physics")[0]).toBe(entry);
  });

  it("filters exact source provenance", () => {
    const results = findCatalogEntries({ provider: "copernicus-marine", variableId: "sithick", identifiers: { product: "GLOBAL_ANALYSISFORECAST_PHY_001_024" } });
    expect(results).toHaveLength(1);
    expect(results[0].aliases).toContain("sea-ice-thickness");
    expect(catalog.schemaVersion).toBe(2);
  });
});

describe("pickPreferredSource", () => {
  const zarr: CatalogSource = { id: "s-zarr", type: "zarr", title: {}, endpoints: { field: "x" }, variables: { kind: "scalar", value: "v" } };
  const wmts: CatalogSource = { id: "s-wmts", type: "wmts", title: {}, capabilitiesUrl: "x", layer: "l" };
  const geovideo: CatalogSource = { id: "s-geovideo", type: "geovideo", title: {}, manifestUrl: "x" };

  function scalarEntry(sources: CatalogSource[]): CatalogEntry {
    return { id: "e", title: {}, category: "c", kind: "scalar", sources, defaults: { sourceId: sources[0].id } };
  }

  it("prefers geovideo over wmts and zarr for scalar entries", () => {
    expect(pickPreferredSource(scalarEntry([zarr, wmts, geovideo])).id).toBe("s-geovideo");
  });

  it("prefers wmts over zarr when geovideo is unavailable", () => {
    expect(pickPreferredSource(scalarEntry([zarr, wmts])).id).toBe("s-wmts");
  });

  it("falls back to zarr when it is the only source", () => {
    expect(pickPreferredSource(scalarEntry([zarr])).id).toBe("s-zarr");
  });

  it("always resolves vector entries to zarr", () => {
    const entry: CatalogEntry = { id: "e", title: {}, category: "c", kind: "vector", sources: [wmts, zarr], defaults: { sourceId: wmts.id } };
    expect(pickPreferredSource(entry).id).toBe("s-zarr");
  });
});
