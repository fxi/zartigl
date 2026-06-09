import { describe, expect, it } from "vitest";
import {
  buildWmtsLegendUrl,
  buildWmtsTileUrl,
  selectArcoLayerBackend,
} from "./ArcoLayer";
import type { ArcoLayerOptions } from "./types";

const scalarWmtsLayer: ArcoLayerOptions["layer"] = {
  id: "scalar",
  label: "Scalar",
  category: "Test",
  kind: "scalar",
  dataset: { id: "dataset" },
  stores: {
    field: {
      type: "zarr",
      url: "https://example.test/scalar.zarr",
      layout: "time-chunked",
    },
    wmts: {
      capabilities_url: "https://example.test/wmts?service=WMTS&request=GetCapabilities",
      base_url: "https://example.test/wmts",
      layer: "PRODUCT/DATASET/chl",
      tileMatrixSet: "EPSG:3857",
      format: "image/png",
      style: "cmap:algae,logScale",
    },
  },
  variables: {
    kind: "scalar",
    value: "chl",
    standardName: "mass_concentration_of_chlorophyll_a_in_sea_water",
    units: "mg m-3",
  },
  dimensions: {
    time: { size: 1 },
    vertical: { label: "depth", values: [0], size: 1 },
  },
  defaults: {},
};

function layerOptions(layer: ArcoLayerOptions["layer"], extra: Partial<ArcoLayerOptions> = {}): ArcoLayerOptions {
  return {
    id: "layer",
    layer,
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
  it("uses Zarr for scalar layers by default even when WMTS metadata exists", () => {
    expect(selectArcoLayerBackend(layerOptions(scalarWmtsLayer))).toBe("scalar-zarr");
  });

  it("uses Zarr for scalar layers when WMTS is unavailable", () => {
    expect(selectArcoLayerBackend(layerOptions({
      ...scalarWmtsLayer,
      stores: { field: scalarWmtsLayer.stores.field },
    }))).toBe("scalar-zarr");
  });

  it("uses vector rendering for vector layers", () => {
    expect(selectArcoLayerBackend(layerOptions({
      id: "vector",
      label: "Vector",
      category: "Test",
      kind: "vector",
      dataset: { id: "dataset" },
      stores: {
        field: {
          type: "zarr",
          url: "https://example.test/vector.zarr",
          layout: "time-chunked",
        },
      },
      variables: { kind: "vector", u: "uo", v: "vo" },
      dimensions: { time: { size: 1 } },
      defaults: {},
    }))).toBe("vector");
  });

  it("uses vector rendering for derived vector layers", () => {
    expect(selectArcoLayerBackend(layerOptions({
      id: "derived-vector",
      label: "Derived Vector",
      category: "Test",
      kind: "vector",
      dataset: { id: "dataset" },
      stores: {
        field: {
          type: "zarr",
          url: "https://example.test/vector.zarr",
          layout: "time-chunked",
        },
      },
      variables: {
        kind: "vector",
        derivation: {
          kind: "direction_magnitude",
          direction_variable: "VMDR_SW1",
          magnitude_variable: "VHM0_SW1",
          direction_convention: "from",
          output_direction: "toward",
        },
      },
      dimensions: { time: { size: 1 } },
      defaults: {},
    }))).toBe("vector");
  });

  it("uses WMTS only when explicitly requested", () => {
    expect(selectArcoLayerBackend(layerOptions(scalarWmtsLayer, { backend: "wmts" }))).toBe("scalar-wmts");
  });
});
