import { describe, expect, it, vi } from "vitest";
import { ArcoLayer } from "./ArcoLayer";
import { Zartigl } from "./Zartigl";
import { ZarrSource } from "./ZarrSource";
import type { Catalog, CatalogLayer } from "../catalog/types";

class FakeMap {
  ready = true;
  layers = new Map<string, unknown>();
  sources = new Map<string, unknown>();
  listeners = new Map<string, Set<() => void>>();

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

  addLayer(layer: { id: string }): void {
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
        type: "zarr",
        url: "https://example.test/field.zarr",
        layout: "time-chunked",
      },
      pointSeries: {
        type: "zarr",
        url: "https://example.test/points.zarr",
        layout: "geo-chunked",
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
      units: "degC",
    },
    dimensions: {
      time: {
        min: 0,
        max: 9_000,
        step: 1_000,
        size: 10,
      },
      vertical: {
        label: "depth",
        values: [0, 10, 20, 30],
        size: 4,
      },
    },
    defaults: {},
    ...extra,
  } as CatalogLayer;
}

function catalog(layer: CatalogLayer = scalarLayer()): Catalog {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-09T00:00:00.000Z",
    layers: [layer],
  };
}

describe("Zartigl facade", () => {
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

  it("uses scalar WMTS when auto backend is requested and the layer default asks for it", async () => {
    const map = new FakeMap();
    const layer = scalarLayer({ defaults: { backend: "wmts" } });
    const z = new Zartigl({ map: map as never, catalog: catalog(layer), backend: "auto" });

    await z.setLayer("scalar");

    const renderLayer = map.getLayer("zartigl") as { getBackend(): string };
    expect(renderLayer.getBackend()).toBe("scalar-wmts");
    expect(z.getBackend()).toBe("wmts");
  });

  it("returns depth metadata surface-nearest first", async () => {
    const map = new FakeMap();
    const layer = scalarLayer({
      dimensions: {
        time: { size: 1 },
        vertical: { label: "depth", values: [100, 0.5, 10], size: 3 },
      },
    });
    const z = new Zartigl({ map: map as never, catalog: catalog(layer) });

    await z.setLayer("scalar");

    expect(z.getDepthMeta().values).toEqual([0.5, 10, 100]);
    expect(z.getDepthMeta().current).toBe(0.5);
  });

  it("returns negative vertical values closest to zero first", async () => {
    const map = new FakeMap();
    const layer = scalarLayer({
      dimensions: {
        time: { size: 1 },
        vertical: { label: "depth", values: [-100, -0.5, -10], size: 3 },
      },
    });
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
});
