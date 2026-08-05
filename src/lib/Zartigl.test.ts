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
  it("defaults to the latest advertised time that is not in the future", async () => {
    const now = Date.UTC(2026, 7, 5, 9);
    const values = [now - 6 * 3600_000, now, now + 6 * 3600_000];
    vi.spyOn(Date, "now").mockReturnValue(now + 3600_000);
    vi.mocked(ZarrSource.prototype.getTimeDimension).mockReturnValueOnce({
      min: values[0],
      max: values[2],
      step: 6 * 3600_000,
      size: values.length,
      units: "milliseconds since 1970-01-01T00:00:00Z",
      values,
    });
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog() });

    await z.setLayer("scalar");

    expect(z.getTimeMeta()).toMatchObject({
      min: values[0],
      max: values[2],
      current: now,
      values,
    });
    vi.mocked(Date.now).mockRestore();
  });

  it("reports metadata loading and metadata failures through status events", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog() });
    const statuses: Array<{ phase: string }> = [];
    z.on("status", (status) => statuses.push(status));

    await z.setLayer("scalar");
    expect(statuses[0]).toEqual({ phase: "metadata" });

    vi.mocked(ZarrSource.prototype.init).mockRejectedValueOnce(new Error("offline"));
    await expect(z.setLayer("scalar")).rejects.toThrow("offline");
    expect(statuses[statuses.length - 1]).toMatchObject({ phase: "error" });
  });

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

  it("passes palette settings to the render layer", async () => {
    const map = new FakeMap();
    const z = new Zartigl({
      map: map as never,
      catalog: catalog(vectorLayer()),
      settings: { palette: "mono-black" },
    });

    await z.setLayer("vector");

    expect(
      (map.getLayer("zartigl") as unknown as {
        options: { colorRamp: string };
      }).options,
    ).toMatchObject({
      colorRamp: "mono-black",
    });
  });

  it("uses a catalog scalar color domain for rendering and the legend", async () => {
    const map = new FakeMap();
    const layer = scalarLayer({
      defaults: {
        backend: "zarr",
        palette: "balance",
        raster: { colorDomain: [-3, 3] },
      },
    });
    const z = new Zartigl({ map: map as never, catalog: catalog(layer) });

    await z.setLayer("scalar");

    expect(
      (map.getLayer("zartigl") as unknown as {
        options: { colorDomain: [number, number] };
      }).options.colorDomain,
    ).toEqual([-3, 3]);
    expect(z.getLegend()).toMatchObject({
      type: "gradient",
      palette: "balance",
      min: -3,
      max: 3,
    });
  });

  it("updates and clears a scalar color domain without recreating the layer", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog(scalarLayer()) });
    await z.setLayer("scalar");
    const renderLayer = map.getLayer("zartigl") as ArcoLayer;
    const spy = vi.spyOn(renderLayer, "setColorDomain");

    z.updateSettings({ colorDomain: [-2, 2] });
    z.updateSettings({ colorDomain: null });

    expect(spy).toHaveBeenNthCalledWith(1, [-2, 2]);
    expect(spy).toHaveBeenNthCalledWith(2, null);
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(1);
  });

  it("rejects an invalid runtime domain without changing facade or layer state", async () => {
    const map = new FakeMap();
    const first = scalarLayer({ defaults: { raster: { colorDomain: [-3, 3] } } });
    const second = scalarLayer({
      id: "second",
      defaults: { raster: { colorDomain: [-1, 1] } },
    });
    const z = new Zartigl({
      map: map as never,
      catalog: { schemaVersion: 1, layers: [first, second] },
    });
    await z.setLayer("scalar");
    const renderLayer = map.getLayer("zartigl") as ArcoLayer;
    const spy = vi.spyOn(renderLayer, "setColorDomain");

    expect(() => z.updateSettings({ colorDomain: [3, -3] })).toThrow(/finite, increasing/);

    expect(spy).not.toHaveBeenCalled();
    expect(z.getLegend()).toMatchObject({ min: -3, max: 3 });
    expect(z.getDebugInfo().settings.colorDomain).toEqual([-3, 3]);

    await z.setLayer("second");
    expect(z.getLegend()).toMatchObject({ min: -1, max: 1 });
  });

  it("rejects invalid constructor settings before registering map listeners", () => {
    const map = new FakeMap();

    expect(() => new Zartigl({
      map: map as never,
      catalog: catalog(),
      settings: { colorDomain: [Number.NaN, 3] },
    })).toThrow(/finite, increasing/);

    expect(map.listeners.size).toBe(0);
  });

  it("rejects an invalid catalog domain without replacing the active layer", async () => {
    const map = new FakeMap();
    const valid = scalarLayer({ defaults: { raster: { colorDomain: [-3, 3] } } });
    const invalid = scalarLayer({
      id: "invalid",
      defaults: { raster: { colorDomain: [2, 2] } },
    });
    const z = new Zartigl({
      map: map as never,
      catalog: { schemaVersion: 1, layers: [valid, invalid] },
    });
    await z.setLayer("scalar");
    const activeLayer = map.getLayer("zartigl");

    await expect(z.setLayer("invalid")).rejects.toThrow(/finite, increasing/);

    expect(map.getLayer("zartigl")).toBe(activeLayer);
    expect(z.getLegend()).toMatchObject({ min: -3, max: 3 });
  });

  it("does not leak a catalog color domain to the next layer", async () => {
    const map = new FakeMap();
    const anomaly = scalarLayer({
      defaults: { raster: { colorDomain: [-3, 3] } },
    });
    const regular = scalarLayer({ id: "regular", defaults: {} });
    const z = new Zartigl({
      map: map as never,
      catalog: { schemaVersion: 1, layers: [anomaly, regular] },
    });

    await z.setLayer("scalar");
    await z.setLayer("regular");

    expect(
      (map.getLayer("zartigl") as unknown as {
        options: { colorDomain: [number, number] | null };
      }).options.colorDomain,
    ).toBeNull();
  });

  it("recreates the render layer when palette changes", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ map: map as never, catalog: catalog(vectorLayer()) });
    await z.setLayer("vector");
    const firstLayer = map.getLayer("zartigl");

    z.updateSettings({ palette: "mono-white" });

    expect(map.getLayer("zartigl")).toBeDefined();
    expect(map.getLayer("zartigl")).not.toBe(firstLayer);
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(2);
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

  it("retries a queued layer on idle without attaching it twice", async () => {
    const map = new FakeMap();
    map.ready = false;
    const z = new Zartigl({ map: map as never, catalog: catalog() });

    await z.setLayer("scalar");
    expect(map.getLayer("zartigl")).toBeUndefined();

    map.ready = true;
    map.emit("idle");
    map.emit("idle");

    expect(map.getLayer("zartigl")).toBeDefined();
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(1);
  });

  it("removes readiness listeners when destroyed", async () => {
    const map = new FakeMap();
    map.ready = false;
    const z = new Zartigl({ map: map as never, catalog: catalog() });

    await z.setLayer("scalar");
    z.destroy();
    map.ready = true;
    map.emit("idle");

    expect(map.getLayer("zartigl")).toBeUndefined();
    expect(map.listeners.get("idle")?.size ?? 0).toBe(0);
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
