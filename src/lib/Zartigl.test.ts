import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArcoLayer } from "./ArcoLayer";
import { Zartigl } from "./Zartigl";
import { ZarrSource } from "./ZarrSource";
import type { Catalog, CatalogLayer } from "../catalog/types";

class FakeMap {
  ready = true;
  layers = new Map<string, unknown>();
  sources = new Map<string, unknown>();
  listeners = new Map<string, Set<() => void>>();
  addLayerCalls: Array<{ id: string; before?: string }> = [];

  on(event: string, handler: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: () => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: string): void {
    this.listeners.get(event)?.forEach((handler) => handler());
  }

  isStyleLoaded(): boolean {
    return this.ready;
  }

  addLayer(layer: { id: string }, before?: string): void {
    this.addLayerCalls.push({ id: layer.id, before });
    this.layers.set(layer.id, layer);
  }

  removeLayer(id: string): void {
    this.layers.delete(id);
  }

  getLayer(id: string): unknown {
    return this.layers.get(id);
  }

  addSource(id: string, source: unknown): void {
    this.sources.set(id, source);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
}

function scalarLayer(extra: Partial<CatalogLayer> = {}): CatalogLayer {
  return {
    id: "scalar",
    label: "Scalar",
    category: "Test",
    kind: "scalar",
    dataset: { id: "dataset" },
    stores: {
      field: {
        url: "https://example.test/field.zarr",
      },
      pointSeries: {
        url: "https://example.test/points.zarr",
      },
      wmts: {
        capabilities_url: "https://example.test/wmts?service=WMTS&request=GetCapabilities",
        base_url: "https://example.test/wmts",
        layer: "PRODUCT/DATASET/scalar",
        tileMatrixSet: "EPSG:3857",
        format: "image/png",
      },
    },
    variables: {
      kind: "scalar",
      value: "temperature",
    },
    defaults: {},
    ...extra,
  } as CatalogLayer;
}

function vectorLayer(extra: Partial<CatalogLayer> = {}): CatalogLayer {
  return {
    id: "vector",
    label: "Vector",
    category: "Test",
    kind: "vector",
    dataset: { id: "dataset" },
    stores: { field: { url: "https://example.test/vector.zarr" } },
    variables: { kind: "vector", u: "u", v: "v" },
    defaults: {},
    ...extra,
  } as CatalogLayer;
}

function catalog(layer: CatalogLayer = scalarLayer()): Catalog {
  return {
    schemaVersion: 1,
    layers: [layer],
  };
}

beforeEach(() => {
  vi.spyOn(ZarrSource.prototype, "init").mockResolvedValue();
  vi.spyOn(ZarrSource.prototype, "hasVariable").mockReturnValue(true);
  vi.spyOn(ZarrSource.prototype, "getVariableAttrs").mockReturnValue({
    units: "degC",
    standard_name: "sea_water_temperature",
  });
  vi.spyOn(ZarrSource.prototype, "getTimeDimension").mockReturnValue({
    min: 0,
    max: 9_000,
    step: 1_000,
    size: 10,
    units: "milliseconds since 1970-01-01T00:00:00Z",
    values: Array.from({ length: 10 }, (_, index) => index * 1_000),
  });
  vi.spyOn(ZarrSource.prototype, "getVerticalDimension").mockReturnValue({
    name: "depth",
    label: "depth",
    units: "m",
    values: [0, 10, 20, 30],
  });
});

describe("Zartigl facade", () => {
  it("uses catalog render mode unless an explicit setting overrides it", async () => {
    const catalogLayer = vectorLayer({
      defaults: { renderMode: "raster+particles" },
    });
    const catalogValue = catalog(catalogLayer);

    const catalogMap = new FakeMap();
    const fromCatalog = new Zartigl({
      map: catalogMap as never,
      catalog: catalogValue,
    });
    await fromCatalog.setLayer("vector");
    expect(
      (catalogMap.getLayer("zartigl") as unknown as {
        options: { renderMode: string };
      }).options.renderMode,
    ).toBe("raster+particles");

    const explicitMap = new FakeMap();
    const explicit = new Zartigl({
      map: explicitMap as never,
      catalog: catalogValue,
      settings: { renderMode: "raster" },
    });
    await explicit.setLayer("vector");
    expect(
      (explicitMap.getLayer("zartigl") as unknown as {
        options: { renderMode: string };
      }).options.renderMode,
    ).toBe("raster");
  });

  it("propagates runtime render mode updates", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog(vectorLayer()) });
    await z.setLayer("vector");
    const renderLayer = map.getLayer("zartigl") as ArcoLayer;
    const spy = vi.spyOn(renderLayer, "setRenderMode");

    z.updateSettings({ renderMode: "raster+particles" });

    expect(spy).toHaveBeenCalledWith("raster+particles");
  });

  it("passes particle state settings to the render layer", async () => {
    const map = new FakeMap();
    const z = new Zartigl({
      map: map as never,
      catalog: catalog(vectorLayer()),
      settings: { particleState: "rgba8", rgba8MaxParticleZoom: 3 },
    });

    await z.setLayer("vector");

    expect(
      (map.getLayer("zartigl") as unknown as {
        options: { particleState: string; rgba8MaxParticleZoom: number };
      }).options,
    ).toMatchObject({
      particleState: "rgba8",
      rgba8MaxParticleZoom: 3,
    });
  });

  it("recreates the render layer when particle state mode changes", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog(vectorLayer()) });
    await z.setLayer("vector");
    const firstLayer = map.getLayer("zartigl");

    z.updateSettings({ particleState: "rgba8" });

    expect(map.getLayer("zartigl")).toBeDefined();
    expect(map.getLayer("zartigl")).not.toBe(firstLayer);
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(2);
  });

  it("updates RGBA8 max zoom without recreating the render layer", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog(vectorLayer()) });
    await z.setLayer("vector");
    const renderLayer = map.getLayer("zartigl") as ArcoLayer;
    const spy = vi.spyOn(renderLayer, "setRgba8MaxParticleZoom");

    z.updateSettings({ rgba8MaxParticleZoom: 2 });

    expect(spy).toHaveBeenCalledWith(2);
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(1);
  });

  it("passes particle color settings to the render layer", async () => {
    const map = new FakeMap();
    const z = new Zartigl({
      map: map as never,
      catalog: catalog(vectorLayer()),
      settings: { particleColorMode: "black" },
    });

    await z.setLayer("vector");

    expect(
      (map.getLayer("zartigl") as unknown as {
        options: { particleColorMode: string };
      }).options,
    ).toMatchObject({
      particleColorMode: "black",
    });
  });

  it("updates particle color mode without recreating the render layer", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog(vectorLayer()) });
    await z.setLayer("vector");
    const renderLayer = map.getLayer("zartigl") as ArcoLayer;
    const spy = vi.spyOn(renderLayer, "setParticleColorMode");

    z.updateSettings({ particleColorMode: "white" });

    expect(spy).toHaveBeenCalledWith("white");
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(1);
  });

  it("queues setLayer until the map style is ready", async () => {
    const map = new FakeMap();
    map.ready = false;
    const z = new Zartigl({ map: map as never, catalog: catalog() });

    await z.setLayer("scalar");

    expect(map.getLayer("zartigl")).toBeUndefined();
    map.ready = true;
    map.emit("load");
    expect(map.getLayer("zartigl")).toBeDefined();
  });

  it("uses the configured id namespace and supports hide/show", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ id: "surface", map: map as never, catalog: catalog() });

    await z.setLayer("scalar");
    expect(map.getLayer("surface")).toBeDefined();

    z.hide();
    expect(map.getLayer("surface")).toBeUndefined();

    z.show();
    expect(map.getLayer("surface")).toBeDefined();
  });

  it("passes optional metadata to the render layer", async () => {
    const map = new FakeMap();
    const metadata = { idView: "mx-view", type: "arco" };
    const z = new Zartigl({
      id: "MX-mx-view",
      map: map as never,
      catalog: catalog(),
      metadata,
    });

    await z.setLayer("scalar");
    metadata.type = "mutated";

    expect(map.getLayer("MX-mx-view")).toMatchObject({
      metadata: { idView: "mx-view", type: "arco" },
    });
  });

  it("adds the render layer before the configured anchor when available", async () => {
    const map = new FakeMap();
    map.addLayer({ id: "mxlayers" });
    const z = new Zartigl({
      id: "MX-layer",
      map: map as never,
      catalog: catalog(),
      before: "mxlayers",
    });

    await z.setLayer("scalar");

    expect(map.addLayerCalls).toContainEqual({ id: "MX-layer", before: "mxlayers" });
  });

  it("falls back to normal layer insertion when the configured anchor is unavailable", async () => {
    const map = new FakeMap();
    const z = new Zartigl({
      id: "MX-layer",
      map: map as never,
      catalog: catalog(),
      before: "missing-anchor",
    });

    await z.setLayer("scalar");

    expect(map.addLayerCalls).toContainEqual({ id: "MX-layer", before: undefined });
  });

  it("uses scalar WMTS when auto backend is requested and the layer default asks for it", async () => {
    const map = new FakeMap();
    const layer = scalarLayer({ defaults: { backend: "wmts" } });
    const z = new Zartigl({ map: map as never, catalog: catalog(layer), backend: "auto" });

    await z.setLayer("scalar");

    const renderLayer = map.getLayer("zartigl") as { getBackend(): string };
    expect(renderLayer.getBackend()).toBe("scalar-wmts");
    expect(z.getBackend()).toBe("wmts");
  });

  it("passes metadata and insertion anchor to WMTS raster sublayers", () => {
    const map = new FakeMap();
    map.addLayer({ id: "mxlayers" });
    const layer = new ArcoLayer({
      id: "MX-raster",
      layer: scalarLayer(),
      backend: "wmts",
      metadata: { idView: "raster-view", type: "arco" },
      before: "mxlayers",
    });

    layer.onAdd(map as never, {} as never);

    expect(map.getLayer("MX-raster-wmts")).toMatchObject({
      metadata: { idView: "raster-view", type: "arco" },
    });
    expect(map.addLayerCalls).toContainEqual({
      id: "MX-raster-wmts",
      before: "mxlayers",
    });
  });

  it("returns depth metadata surface-nearest first", async () => {
    const map = new FakeMap();
    vi.mocked(ZarrSource.prototype.getVerticalDimension).mockReturnValue({
      name: "depth", label: "depth", units: "m", values: [100, 0.5, 10],
    });
    const layer = scalarLayer();
    const z = new Zartigl({ map: map as never, catalog: catalog(layer) });

    await z.setLayer("scalar");

    expect(z.getDepthMeta().values).toEqual([0.5, 10, 100]);
    expect(z.getDepthMeta().current).toBe(0.5);
  });

  it("returns negative vertical values closest to zero first", async () => {
    const map = new FakeMap();
    vi.mocked(ZarrSource.prototype.getVerticalDimension).mockReturnValue({
      name: "depth", label: "depth", units: "m", values: [-100, -0.5, -10],
    });
    const layer = scalarLayer();
    const z = new Zartigl({ map: map as never, catalog: catalog(layer) });

    await z.setLayer("scalar");

    expect(z.getDepthMeta().values).toEqual([-0.5, -10, -100]);
    expect(z.getDepthMeta().current).toBe(-0.5);
  });

  it("forwards atomic time/depth changes to the active layer", async () => {
    const spy = vi.spyOn(ArcoLayer.prototype, "setTimeAndDepth");
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog() });

    await z.setLayer("scalar");
    z.setTimeAndDepth(4_000, 20);

    expect(z.getTimeMeta().current).toBe(4_000);
    expect(z.getDepthMeta().current).toBe(20);
    expect(spy).toHaveBeenCalledWith(4_000, 20);
  });

  it("limits time-series and depth-profile queries", async () => {
    const timeSpy = vi
      .spyOn(ZarrSource.prototype, "sampleTimeSeries")
      .mockResolvedValue({ longitude: 0, latitude: 0, points: [] });
    const depthSpy = vi
      .spyOn(ZarrSource.prototype, "sampleVerticalProfile")
      .mockResolvedValue({ longitude: 0, latitude: 0, points: [] });
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog() });

    await z.setLayer("scalar");
    await z.queryTimeSeries({ longitude: 1, latitude: 2, maxPoints: 3 });
    await z.queryDepthProfile({ longitude: 1, latitude: 2, maxDepths: 2 });

    expect(timeSpy).toHaveBeenCalledWith(expect.objectContaining({ stride: 4 }));
    expect(depthSpy).toHaveBeenCalledWith(expect.objectContaining({ maxDepths: 2 }));
  });

  it("preserves the active layer when candidate metadata loading fails", async () => {
    const first = scalarLayer();
    const second = {
      ...scalarLayer(),
      id: "second",
      stores: {
        ...scalarLayer().stores,
        field: { url: "https://example.test/second.zarr" },
      },
    } as CatalogLayer;
    const map = new FakeMap();
    const z = new Zartigl({
      map: map as never,
      catalog: { schemaVersion: 1, layers: [first, second] },
    });
    const errors: Error[] = [];
    z.on("error", (error) => errors.push(error));

    await z.setLayer("scalar");
    const active = map.getLayer("zartigl");
    vi.mocked(ZarrSource.prototype.init).mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(z.setLayer("second")).rejects.toThrow("metadata unavailable");
    expect(map.getLayer("zartigl")).toBe(active);
    expect(z.getTimeMeta().current).toBe(9_000);
    expect(errors[errors.length - 1]?.message).toBe("metadata unavailable");
  });
});
