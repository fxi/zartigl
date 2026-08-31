import { describe, expect, it } from "vitest";
import { catalog } from "../catalog";
import { buildCatalogResultMetadata } from "./CatalogPicker";

function layer(alias: string) {
  const entry = catalog.layers.find((candidate) => candidate.aliases?.includes(alias));
  if (!entry) throw new Error(`Missing catalog fixture: ${alias}`);
  return entry;
}

describe("buildCatalogResultMetadata", () => {
  it("summarizes provenance, cadence, source types, and scalar variables", () => {
    const metadata = buildCatalogResultMetadata(layer("sea-water-temperature"));

    expect(metadata.overview).toContain("ocean · scalar · copernicus-marine");
    expect(metadata.overview).toContain("Zarr/WMTS");
    expect(metadata.identifiers).toContain("GLOBAL_ANALYSISFORECAST_PHY_001_024");
    expect(metadata.identifiers).toContain("cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m");
    expect(metadata.details).toBe("analysis-forecast · P1D · vars: thetao");
  });

  it("shows both variables used by a derived vector layer", () => {
    const metadata = buildCatalogResultMetadata(layer("primary-swell-propagation"));

    expect(metadata.overview).toContain("waves · vector");
    expect(metadata.details).toContain("vars: VMDR_SW1, VHM0_SW1");
  });
});
