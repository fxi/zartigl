import { describe, expect, it } from "vitest";
import { catalog, findCatalogEntries, getCatalogEntry, searchCatalog } from "./index";

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

  it("filters exact source provenance", () => {
    const results = findCatalogEntries({ provider: "copernicus-marine", variableId: "sithick", identifiers: { product: "GLOBAL_ANALYSISFORECAST_PHY_001_024" } });
    expect(results).toHaveLength(1);
    expect(results[0].aliases).toContain("sea-ice-thickness");
    expect(catalog.schemaVersion).toBe(2);
  });
});
