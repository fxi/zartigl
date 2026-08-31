import { describe, expect, it } from "vitest";
import { CatalogRenderLayer, buildWmtsLegendUrl, buildWmtsTileUrl, resolveWmtsTileTemplate, selectCatalogRenderLayerBackend } from "./CatalogRenderLayer";
import type { CatalogEntry, CatalogGeoVideoSource, CatalogSource, CatalogWmtsSource, CatalogZarrSource } from "../catalog/types";
import type { CatalogRenderLayerOptions } from "./types";

const zarr: CatalogZarrSource = { id: "zarr", type: "zarr", title: { en: "Zarr" }, endpoints: { field: "https://example.test/scalar.zarr" }, variables: { kind: "scalar", value: "chl" } };
const wmts: CatalogWmtsSource = { id: "wmts", type: "wmts", title: { en: "WMTS" }, capabilitiesUrl: "https://example.test/capabilities", baseUrl: "https://example.test/wmts", layer: "PRODUCT/DATASET/chl", tileMatrixSet: "EPSG:3857", format: "image/png", style: "cmap:algae,logScale" };
const video: CatalogGeoVideoSource = { id: "video", type: "geovideo", title: { en: "Video" }, manifestUrl: "https://example.test/manifest.json" };
const entry: CatalogEntry = { id: "entry", title: { en: "Scalar" }, category: "test", kind: "scalar", sources: [zarr, wmts, video], defaults: { sourceId: zarr.id } };
function options(sourceConfig: CatalogSource = zarr, extra: Partial<CatalogRenderLayerOptions> = {}): CatalogRenderLayerOptions {
  return { id: "layer", entry, sourceConfig, ...extra };
}

describe("WMTS URL helpers", () => {
  it("builds KVP tile URLs without encoding MapLibre placeholders", () => {
    const url = buildWmtsTileUrl({ baseUrl: wmts.baseUrl!, layer: wmts.layer, tileMatrixSet: wmts.tileMatrixSet!, format: wmts.format!, style: wmts.style, time: Date.UTC(2026, 5, 4), depth: 0.5, verticalLabel: "depth" });
    expect(url).toContain("TILEMATRIX={z}");
    expect(url).toContain("LAYER=PRODUCT%2FDATASET%2Fchl");
    expect(url).toContain("time=2026-06-04T00%3A00%3A00.000Z");
    expect(url).toContain("elevation=-0.5");
  });

  it("builds a server legend URL", () => {
    expect(buildWmtsLegendUrl({ baseUrl: wmts.baseUrl!, layer: wmts.layer, style: wmts.style })).toContain("REQUEST=GetLegend");
  });

  it("resolves REST template dimensions while preserving tile placeholders", () => {
    const url = resolveWmtsTileTemplate({
      template: "https://tiles.test/{TileMatrix}/{TileRow}/{TileCol}?time={Time}&elevation={elevation}",
      tileMatrixSet: "EPSG:3857",
      style: "default",
      time: Date.UTC(2026, 5, 4),
      depth: 12,
      verticalLabel: "depth",
    });
    expect(url).toBe("https://tiles.test/{z}/{y}/{x}?time=2026-06-04T00%3A00%3A00.000Z&elevation=-12");
  });

  it("falls back when a REST template still contains an unknown placeholder", () => {
    expect(resolveWmtsTileTemplate({ template: "https://tiles.test/{z}/{unknown}", time: 1 })).toBeUndefined();
  });
});

describe("source dispatch", () => {
  it("selects the renderer from the discriminated source", () => {
    expect(selectCatalogRenderLayerBackend(options(zarr))).toBe("scalar-zarr");
    expect(selectCatalogRenderLayerBackend(options(wmts))).toBe("scalar-wmts");
    expect(selectCatalogRenderLayerBackend(options(video))).toBe("scalar-geovideo");
    const vectorSource: CatalogZarrSource = { ...zarr, variables: { kind: "vector", u: "u", v: "v" } };
    const vectorEntry: CatalogEntry = { ...entry, kind: "vector", sources: [vectorSource] };
    expect(selectCatalogRenderLayerBackend({ ...options(vectorSource), entry: vectorEntry })).toBe("vector-zarr");
  });

  it("detaches WMTS while suspended and restores the latest time", () => {
    const layers = new Map<string, unknown>(), sources = new Map<string, unknown>();
    const map = { addLayer: (value: { id: string }) => layers.set(value.id, value), removeLayer: (id: string) => layers.delete(id), getLayer: (id: string) => layers.get(id), addSource: (id: string, value: unknown) => sources.set(id, value), removeSource: (id: string) => sources.delete(id), getSource: (id: string) => sources.get(id) };
    const layer = new CatalogRenderLayer(options(wmts, { time: 1_000 }));
    layer.onAdd(map as never, {} as never);
    layer.suspend();
    layer.setTime(2_000);
    expect(sources.has("layer-wmts-source")).toBe(false);
    layer.resume();
    expect((sources.get("layer-wmts-source") as { tiles: string[] }).tiles[0]).toContain(encodeURIComponent(new Date(2_000).toISOString()));
  });
});
