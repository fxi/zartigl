import { describe, expect, it } from "vitest";
import {
  buildWmtsLegendUrl,
  buildWmtsTileUrl,
  selectArcoLayerBackend,
} from "./ArcoLayer";
import type { ArcoLayerOptions } from "./types";

const scalarWmtsView: ArcoLayerOptions["view"] = {
  type: "scalar",
  zarr_url_geo: "https://example.test/scalar.zarr",
  variable: "chl",
  variable_meta: {
    standard_name: "mass_concentration_of_chlorophyll_a_in_sea_water",
    units: "mg m-3",
  },
  vertical_label: "depth",
  wmts: {
    capabilities_url: "https://example.test/wmts?service=WMTS&request=GetCapabilities",
    base_url: "https://example.test/wmts",
    layer: "PRODUCT/DATASET/chl",
    tileMatrixSet: "EPSG:3857",
    format: "image/png",
    style: "cmap:algae,logScale",
  },
};

function layerOptions(view: ArcoLayerOptions["view"], extra: Partial<ArcoLayerOptions> = {}): ArcoLayerOptions {
  return {
    id: "layer",
    view,
    ...extra,
  };
}

describe("buildWmtsTileUrl", () => {
  it("builds a KVP GetTile URL with MapLibre tile placeholders intact", () => {
    const url = buildWmtsTileUrl({
      baseUrl: "https://example.test/wmts",
      layer: "PRODUCT/DATASET/chl",
      tileMatrixSet: "EPSG:3857",
      format: "image/png",
      style: "cmap:algae,logScale",
      time: Date.UTC(2026, 5, 4),
      depth: 0.4940253794193268,
      verticalLabel: "depth",
    });

    expect(url).toContain("REQUEST=GetTile");
    expect(url).toContain("LAYER=PRODUCT%2FDATASET%2Fchl");
    expect(url).toContain("FORMAT=image%2Fpng");
    expect(url).toContain("TILEMATRIXSET=EPSG%3A3857");
    expect(url).toContain("TILEMATRIX={z}");
    expect(url).toContain("TILEROW={y}");
    expect(url).toContain("TILECOL={x}");
    expect(url).toContain("STYLE=cmap%3Aalgae%2ClogScale");
    expect(url).toContain("time=2026-06-04T00%3A00%3A00.000Z");
    expect(url).toContain("elevation=-0.4940253794193268");
  });

  it("omits optional style, time, and elevation parameters when not provided", () => {
    const url = buildWmtsTileUrl({
      baseUrl: "https://example.test/wmts",
      layer: "PRODUCT/DATASET/chl",
      tileMatrixSet: "EPSG:3857",
      format: "image/png",
    });

    expect(url).not.toContain("STYLE=");
    expect(url).not.toContain("time=");
    expect(url).not.toContain("elevation=");
  });
});

describe("buildWmtsLegendUrl", () => {
  it("builds a GetLegend URL for the server-side WMTS style", () => {
    const url = buildWmtsLegendUrl({
      baseUrl: "https://example.test/wmts",
      layer: "PRODUCT/DATASET/chl",
      style: "cmap:algae,logScale",
    });

    expect(url).toContain("REQUEST=GetLegend");
    expect(url).toContain("LAYER=PRODUCT%2FDATASET%2Fchl");
    expect(url).toContain("STYLE=cmap%3Aalgae%2ClogScale");
    expect(url).toContain("FORMAT=image%2Fsvg%2Bxml");
  });
});

describe("selectArcoLayerBackend", () => {
  it("uses Zarr for scalar views by default even when WMTS metadata exists", () => {
    expect(selectArcoLayerBackend(layerOptions(scalarWmtsView))).toBe("scalar-zarr");
  });

  it("uses Zarr for scalar views when WMTS is unavailable", () => {
    expect(selectArcoLayerBackend(layerOptions({
      ...scalarWmtsView,
      wmts: undefined,
    }))).toBe("scalar-zarr");
  });

  it("uses vector rendering for vector views", () => {
    expect(selectArcoLayerBackend(layerOptions({
      type: "vector",
      zarr_url_geo: "https://example.test/vector.zarr",
      variable_u: "uo",
      variable_v: "vo",
    }))).toBe("vector");
  });

  it("uses vector rendering for derived vector views", () => {
    expect(selectArcoLayerBackend(layerOptions({
      type: "vector",
      zarr_url_geo: "https://example.test/vector.zarr",
      vector_derivation: {
        kind: "direction_magnitude",
        direction_variable: "VMDR_SW1",
        magnitude_variable: "VHM0_SW1",
        direction_convention: "from",
        output_direction: "toward",
      },
    }))).toBe("vector");
  });

  it("uses WMTS only when explicitly requested", () => {
    expect(selectArcoLayerBackend(layerOptions(scalarWmtsView, { backend: "wmts" }))).toBe("scalar-wmts");
  });
});
