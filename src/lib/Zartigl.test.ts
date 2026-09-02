import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogRenderLayer } from "./CatalogRenderLayer";
import { Zartigl } from "./Zartigl";
import type { ZartiglOptions } from "./Zartigl";
import { ZarrSource } from "./ZarrSource";
import type { Catalog, CatalogEntry } from "../catalog/types";

const GEO_ENTRY_ID = "5e94f1b2-1342-4a1f-936e-09170d7d4db8";
const GEO_ZARR_ID = "9be43e20-eb9e-44e3-bc8b-a733f7a7eda0";
const GEO_VIDEO_ID = "e260c26f-8374-4c65-a076-5cd181ed5091";

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

function scalarLayer(extra: Record<string, any> = {}): CatalogEntry {
  const zarr = { id: extra.zarrId ?? "zarr", type: "zarr" as const, title: { en: "Zarr" }, endpoints: {
    field: extra.stores?.field?.url ?? "https://example.test/field.zarr",
    pointSeries: extra.stores?.pointSeries?.url ?? "https://example.test/points.zarr",
  }, variables: extra.variables ?? { kind: "scalar" as const, value: "temperature" } };
  const wmts = { id: "wmts", type: "wmts" as const, title: { en: "WMTS" }, capabilitiesUrl: "https://example.test/wmts?service=WMTS&request=GetCapabilities", baseUrl: "https://example.test/wmts", layer: "PRODUCT/DATASET/scalar", tileMatrixSet: "EPSG:3857", format: "image/png" };
  const videos = (extra.derived?.geoVideos ?? []).map((video: { id?: string; manifestUrl: string }, index: number) => ({ id: video.id ?? `video-${index}`, type: "geovideo" as const, title: { en: "Video" }, manifestUrl: video.manifestUrl }));
  const requestedDefault = extra.defaults?.sourceId ?? zarr.id;
  const defaultOverrides = extra.defaults ?? {};
  return { id: extra.id ?? "scalar", title: { en: extra.label ?? "Scalar" }, category: "test", kind: "scalar",
    sources: [zarr, ...(extra.stores?.wmts === undefined && extra.stores ? [] : [wmts]), ...videos],
    defaults: { sourceId: requestedDefault, querySourceId: zarr.id, ...defaultOverrides } };
}

function vectorLayer(extra: Record<string, any> = {}): CatalogEntry {
  const source = { id: "vector-zarr", type: "zarr" as const, title: { en: "Zarr" }, endpoints: { field: "https://example.test/vector.zarr" }, variables: extra.variables ?? { kind: "vector" as const, u: "u", v: "v" } };
  return { id: extra.id ?? "vector", title: { en: "Vector" }, category: "test", kind: "vector", sources: [source], defaults: { sourceId: source.id, ...(extra.defaults ?? {}) } };
}

function catalog(layer: CatalogEntry = scalarLayer()): Catalog {
  return {
    schemaVersion: 2,
    defaultLocale: "en",
    layers: [layer],
  };
}

async function createZartigl(options: Omit<ZartiglOptions, "layer">, layer: string): Promise<Zartigl> {
  const zartigl = new Zartigl({ ...options, layer });
  await zartigl.init();
  return zartigl;
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
  it("requires one explicit initialization before accepting updates", async () => {
    const z = new Zartigl({
      map: new FakeMap() as never,
      catalog: catalog(),
      layer: "scalar",
      source: "zarr",
    });

    await expect(z.update({ time: 1_000 })).rejects.toThrow("Call init() before update()");
    await z.init();
    await expect(z.init()).rejects.toThrow("already been initialized");
  });

  it("applies declarative time, depth, settings, and visibility during init", async () => {
    const map = new FakeMap();
    const z = new Zartigl({
      map: map as never,
      catalog: catalog(),
      layer: "scalar",
      source: "zarr",
      time: 4_400,
      depth: 18,
      settings: { opacity: 0.4, colorDomain: [-2, 2] },
      visible: false,
    });

    await z.init();

    expect(z.getTimeMeta().current).toBe(4_000);
    expect(z.getDepthMeta().current).toBe(20);
    expect(z.getDebugInfo()).toMatchObject({
      visible: false,
      settings: { opacity: 0.4, colorDomain: [-2, 2] },
    });
    expect(map.getLayer("zartigl")).toBeUndefined();
  });

  it("loads an explicit GeoVideo backend without initializing the field Zarr store", async () => {
    const layer = scalarLayer({
      id: GEO_ENTRY_ID,
      zarrId: GEO_ZARR_ID,
      derived: {
        geoVideos: [{ id: GEO_VIDEO_ID, manifestUrl: "https://example.test/manifest.json" }],
      },
    });
    const manifest = {
      schemaVersion: 3,
      id: GEO_VIDEO_ID,
      type: "geovideo",
      projection: "equirectangular",
      bounds: [-180, -90, 180, 90],
      media: {
        url: "video.mp4",
        mimeType: "video/mp4",
        width: 16,
        height: 8,
        fps: 2,
        durationSeconds: 2,
        codec: "h264",
      },
      encoding: {
        kind: "scalar-luma",
        bits: 8,
        codeMin: 8,
        codeMax: 247,
        valueMin: -3,
        valueMax: 3,
        transfer: "linear",
        colorSpace: "bt709",
        colorRange: "limited",
      },
      mask: {
        kind: "static-validity",
        url: "mask.png",
        mimeType: "image/png",
        width: 16,
        height: 8,
        threshold: 0.5,
      },
      timeline: {
        kind: "range",
        dateStart: "2026-01-01T00:00:00Z",
        dateEnd: "2026-01-02T00:00:00Z",
        interpolation: "linear",
      },
      provenance: {
        catalogEntryId: GEO_ENTRY_ID,
        inputSourceId: GEO_ZARR_ID,
        identifiers: { dataset: "dataset" },
        variables: ["temperature"],
        generatedAt: "2026-01-03T00:00:00Z",
      },
      style: { palette: "balance", colorDomain: [-3, 3], unit: "degC" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }));
    vi.mocked(ZarrSource.prototype.init).mockClear();
    const map = new FakeMap();
    const z = await createZartigl({ map: map as never, catalog: catalog(layer), source: "geovideo" }, GEO_ENTRY_ID);

    expect(ZarrSource.prototype.init).not.toHaveBeenCalled();
    expect(z.getSource()?.type).toBe("geovideo");
    expect(z.supportsDynamicStyle()).toBe(true);
    expect(z.getLegend()).toMatchObject({ min: -3, max: 3, unit: "degC" });
    await z.update({ settings: { palette: "ice", colorDomain: [0, 5] } });
    expect(z.getLegend()).toMatchObject({ palette: "ice", min: 0, max: 5 });
    expect(z.getTimeMeta()).toMatchObject({ size: 4 });
    const querySpy = vi
      .spyOn(ZarrSource.prototype, "sampleTimeSeries")
      .mockResolvedValue({ longitude: 0, latitude: 0, points: [] });
    await z.queryTimeSeries({ longitude: 1, latitude: 2 });
    expect(ZarrSource.prototype.init).toHaveBeenCalledOnce();
    expect(querySpy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("keeps a caller-requested palette for a GeoVideo layer instead of the manifest default", async () => {
    const layer = scalarLayer({
      id: GEO_ENTRY_ID,
      zarrId: GEO_ZARR_ID,
      derived: {
        geoVideos: [{ id: GEO_VIDEO_ID, manifestUrl: "https://example.test/manifest.json" }],
      },
    });
    const manifest = {
      schemaVersion: 3,
      id: GEO_VIDEO_ID,
      type: "geovideo",
      projection: "equirectangular",
      bounds: [-180, -90, 180, 90],
      media: {
        url: "video.mp4",
        mimeType: "video/mp4",
        width: 16,
        height: 8,
        fps: 2,
        durationSeconds: 2,
        codec: "h264",
      },
      encoding: {
        kind: "scalar-luma",
        bits: 8,
        codeMin: 8,
        codeMax: 247,
        valueMin: -3,
        valueMax: 3,
        transfer: "linear",
        colorSpace: "bt709",
        colorRange: "limited",
      },
      mask: {
        kind: "static-validity",
        url: "mask.png",
        mimeType: "image/png",
        width: 16,
        height: 8,
        threshold: 0.5,
      },
      timeline: {
        kind: "range",
        dateStart: "2026-01-01T00:00:00Z",
        dateEnd: "2026-01-02T00:00:00Z",
        interpolation: "linear",
      },
      provenance: {
        catalogEntryId: GEO_ENTRY_ID,
        inputSourceId: GEO_ZARR_ID,
        identifiers: { dataset: "dataset" },
        variables: ["temperature"],
        generatedAt: "2026-01-03T00:00:00Z",
      },
      style: { palette: "balance", colorDomain: [-3, 3], unit: "degC" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }));
    const map = new FakeMap();
    const z = await createZartigl({
      map: map as never,
      catalog: catalog(layer),
      source: "geovideo",
      settings: { palette: "oxygen" },
    }, GEO_ENTRY_ID);

    expect(z.getLegend()).toMatchObject({ palette: "oxygen" });
    vi.unstubAllGlobals();
  });

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
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");

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
    const z = new Zartigl({ source: "zarr", map: map as never, catalog: catalog(), layer: "scalar" });
    const statuses: Array<{ phase: string }> = [];
    z.on("status", (status) => statuses.push(status));

    vi.mocked(ZarrSource.prototype.init).mockRejectedValueOnce(new Error("offline"));
    await expect(z.init()).rejects.toThrow("offline");
    expect(statuses[0]).toEqual({ phase: "metadata" });
    expect(statuses[statuses.length - 1]).toMatchObject({ phase: "error" });
  });

  it("uses catalog render mode unless an explicit setting overrides it", async () => {
    const catalogLayer = vectorLayer({
      defaults: { renderMode: "raster+particles" },
    });
    const catalogValue = catalog(catalogLayer);

    const catalogMap = new FakeMap();
    const fromCatalog = new Zartigl({
      source: "zarr",
      map: catalogMap as never,
      catalog: catalogValue,
      layer: "vector",
    });
    await fromCatalog.init();
    expect(
      (catalogMap.getLayer("zartigl") as unknown as {
        options: { renderMode: string };
      }).options.renderMode,
    ).toBe("raster+particles");

    const explicitMap = new FakeMap();
    const explicit = new Zartigl({
      source: "zarr",
      map: explicitMap as never,
      catalog: catalogValue,
      layer: "vector",
      settings: { renderMode: "raster" },
    });
    await explicit.init();
    expect(
      (explicitMap.getLayer("zartigl") as unknown as {
        options: { renderMode: string };
      }).options.renderMode,
    ).toBe("raster");
  });

  it("defaults scalar layers to raster and vector layers to particles", async () => {
    for (const [layer, expected] of [
      [scalarLayer(), "raster"],
      [vectorLayer(), "particles"],
    ] as const) {
      const map = new FakeMap();
      const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(layer) }, layer.id);

      expect(
        (map.getLayer("zartigl") as unknown as {
          options: { renderMode: string };
        }).options.renderMode,
      ).toBe(expected);
    }
  });

  it("propagates runtime render mode updates", async () => {
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(vectorLayer()) }, "vector");
    const renderLayer = map.getLayer("zartigl") as CatalogRenderLayer;
    const spy = vi.spyOn(renderLayer, "setRenderMode");

    await z.update({ settings: { renderMode: "raster+particles" } });

    expect(spy).toHaveBeenCalledWith("raster+particles");
  });

  it("passes particle state settings to the render layer", async () => {
    const map = new FakeMap();
    const z = await createZartigl({
      source: "zarr",
      map: map as never,
      catalog: catalog(vectorLayer()),
      settings: { particleState: "rgba8", rgba8MaxParticleZoom: 3 },
    }, "vector");

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
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(vectorLayer()) }, "vector");
    const firstLayer = map.getLayer("zartigl");

    await z.update({ settings: { particleState: "rgba8" } });

    expect(map.getLayer("zartigl")).toBeDefined();
    expect(map.getLayer("zartigl")).not.toBe(firstLayer);
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(2);
  });

  it("updates RGBA8 max zoom without recreating the render layer", async () => {
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(vectorLayer()) }, "vector");
    const renderLayer = map.getLayer("zartigl") as CatalogRenderLayer;
    const spy = vi.spyOn(renderLayer, "setRgba8MaxParticleZoom");

    await z.update({ settings: { rgba8MaxParticleZoom: 2 } });

    expect(spy).toHaveBeenCalledWith(2);
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(1);
  });

  it("passes palette settings to the render layer", async () => {
    const map = new FakeMap();
    const z = await createZartigl({
      source: "zarr",
      map: map as never,
      catalog: catalog(vectorLayer()),
      settings: { palette: "mono-black" },
    }, "vector");

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
        palette: "balance",
        raster: { colorDomain: [-3, 3] },
      },
    });
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(layer) }, "scalar");

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
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(scalarLayer()) }, "scalar");
    const renderLayer = map.getLayer("zartigl") as CatalogRenderLayer;
    const spy = vi.spyOn(renderLayer, "setColorDomain");

    await z.update({ settings: { colorDomain: [-2, 2] } });
    await z.update({ settings: { colorDomain: null } });

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
    const z = await createZartigl({
      source: "zarr",
      map: map as never,
      catalog: { schemaVersion: 2, defaultLocale: "en", layers: [first, second] },
    }, "scalar");
    const renderLayer = map.getLayer("zartigl") as CatalogRenderLayer;
    const spy = vi.spyOn(renderLayer, "setColorDomain");

    await expect(z.update({ settings: { colorDomain: [3, -3] } })).rejects.toThrow(/finite, increasing/);

    expect(spy).not.toHaveBeenCalled();
    expect(z.getLegend()).toMatchObject({ min: -3, max: 3 });
    expect(z.getDebugInfo().settings.colorDomain).toEqual([-3, 3]);

    await z.update({ layer: "second", source: "zarr" });
    expect(z.getLegend()).toMatchObject({ min: -1, max: 1 });
  });

  it("rejects invalid constructor settings before registering map listeners", () => {
    const map = new FakeMap();

    expect(() => new Zartigl({
      source: "zarr",
      map: map as never,
      catalog: catalog(),
      layer: "scalar",
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
    const z = await createZartigl({
      source: "zarr",
      map: map as never,
      catalog: { schemaVersion: 2, defaultLocale: "en", layers: [valid, invalid] },
    }, "scalar");
    const activeLayer = map.getLayer("zartigl");

    await expect(z.update({ layer: "invalid" })).rejects.toThrow(/finite, increasing/);

    expect(map.getLayer("zartigl")).toBe(activeLayer);
    expect(z.getLegend()).toMatchObject({ min: -3, max: 3 });
  });

  it("does not leak a catalog color domain to the next layer", async () => {
    const map = new FakeMap();
    const anomaly = scalarLayer({
      defaults: { raster: { colorDomain: [-3, 3] } },
    });
    const regular = scalarLayer({ id: "regular", defaults: {} });
    const z = await createZartigl({
      source: "zarr",
      map: map as never,
      catalog: { schemaVersion: 2, defaultLocale: "en", layers: [anomaly, regular] },
    }, "scalar");
    await z.update({ layer: "regular", source: "zarr" });

    expect(
      (map.getLayer("zartigl") as unknown as {
        options: { colorDomain: [number, number] | null };
      }).options.colorDomain,
    ).toBeNull();
  });

  it("recreates the render layer when palette changes", async () => {
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(vectorLayer()) }, "vector");
    const firstLayer = map.getLayer("zartigl");

    await z.update({ settings: { palette: "mono-white" } });

    expect(map.getLayer("zartigl")).toBeDefined();
    expect(map.getLayer("zartigl")).not.toBe(firstLayer);
    expect(map.addLayerCalls.filter((call) => call.id === "zartigl")).toHaveLength(2);
  });

  it("queues setLayer until the map style is ready", async () => {
    const map = new FakeMap();
    map.ready = false;
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");

    expect(map.getLayer("zartigl")).toBeUndefined();
    map.ready = true;
    map.emit("load");
    expect(map.getLayer("zartigl")).toBeDefined();
  });

  it("retries a queued layer on idle without attaching it twice", async () => {
    const map = new FakeMap();
    map.ready = false;
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");
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
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");
    z.destroy();
    map.ready = true;
    map.emit("idle");

    expect(map.getLayer("zartigl")).toBeUndefined();
    expect(map.listeners.get("idle")?.size ?? 0).toBe(0);
  });

  it("uses the configured id namespace and supports hide/show", async () => {
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", id: "surface", map: map as never, catalog: catalog() }, "scalar");
    expect(map.getLayer("surface")).toBeDefined();

    await z.update({ visible: false });
    expect(map.getLayer("surface")).toBeUndefined();

    await z.update({ visible: true });
    expect(map.getLayer("surface")).toBeDefined();
  });

  it("defers attachment while suspended and resumes with the selected layer", async () => {
    const map = new FakeMap();
    const z = new Zartigl({ source: "zarr", map: map as never, catalog: catalog(), layer: "scalar" });

    z.suspend();
    await z.init();
    expect(map.getLayer("zartigl")).toBeUndefined();
    expect(z.getDebugInfo().suspended).toBe(true);

    z.resume();
    expect(map.getLayer("zartigl")).toBeDefined();
    expect(z.getDebugInfo().suspended).toBe(false);
  });

  it("forwards suspension to an attached render layer", async () => {
    const suspend = vi.spyOn(CatalogRenderLayer.prototype, "suspend");
    const resume = vi.spyOn(CatalogRenderLayer.prototype, "resume");
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");

    z.suspend();
    z.suspend();
    z.resume();
    z.resume();

    expect(suspend).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it("loads the latest requested state when suspension ends", async () => {
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");

    z.suspend();
    await z.update({ time: 4_000, depth: 20 });
    z.resume();

    const debug = z.getDebugInfo();
    expect(debug.layer?.delegate).toMatchObject({ time: 4_000, depth: 20 });
  });

  it("passes optional metadata to the render layer", async () => {
    const map = new FakeMap();
    const metadata = { idView: "mx-view", type: "arco" };
    const z = await createZartigl({
      source: "zarr",
      id: "MX-mx-view",
      map: map as never,
      catalog: catalog(),
      metadata,
    }, "scalar");
    metadata.type = "mutated";

    expect(map.getLayer("MX-mx-view")).toMatchObject({
      metadata: { idView: "mx-view", type: "arco" },
    });
  });

  it("adds the render layer before the configured anchor when available", async () => {
    const map = new FakeMap();
    map.addLayer({ id: "mxlayers" });
    const z = await createZartigl({
      source: "zarr",
      id: "MX-layer",
      map: map as never,
      catalog: catalog(),
      before: "mxlayers",
    }, "scalar");

    expect(map.addLayerCalls).toContainEqual({ id: "MX-layer", before: "mxlayers" });
  });

  it("falls back to normal layer insertion when the configured anchor is unavailable", async () => {
    const map = new FakeMap();
    const z = await createZartigl({
      source: "zarr",
      id: "MX-layer",
      map: map as never,
      catalog: catalog(),
      before: "missing-anchor",
    }, "scalar");

    expect(map.addLayerCalls).toContainEqual({ id: "MX-layer", before: undefined });
  });

  it("uses scalar WMTS when the entry's default source asks for it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => `
      <Capabilities><Contents><Layer><Identifier>PRODUCT/DATASET/scalar</Identifier>
      <Format>image/png</Format><TileMatrixSetLink><TileMatrixSet>EPSG:3857</TileMatrixSet></TileMatrixSetLink>
      <Dimension><Identifier>time</Identifier><Value>2026-01-01T00:00:00Z</Value></Dimension>
      </Layer></Contents></Capabilities>` }));
    const map = new FakeMap();
    const layer = scalarLayer({ defaults: { sourceId: "wmts" } });
    const z = await createZartigl({ map: map as never, catalog: catalog(layer), source: "auto" }, "scalar");

    const renderLayer = map.getLayer("zartigl") as { getBackend(): string };
    expect(renderLayer.getBackend()).toBe("scalar-wmts");
    expect(z.getSource()?.type).toBe("wmts");
    expect(z.supportsDynamicStyle()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("passes metadata and insertion anchor to WMTS raster sublayers", () => {
    const map = new FakeMap();
    map.addLayer({ id: "mxlayers" });
    const layer = new CatalogRenderLayer({
      id: "MX-raster",
      entry: scalarLayer(),
      sourceConfig: scalarLayer().sources.find((source) => source.type === "wmts")!,
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
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(layer) }, "scalar");

    expect(z.getDepthMeta().values).toEqual([0.5, 10, 100]);
    expect(z.getDepthMeta().current).toBe(0.5);
  });

  it("returns negative vertical values closest to zero first", async () => {
    const map = new FakeMap();
    vi.mocked(ZarrSource.prototype.getVerticalDimension).mockReturnValue({
      name: "depth", label: "depth", units: "m", values: [-100, -0.5, -10],
    });
    const layer = scalarLayer();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(layer) }, "scalar");

    expect(z.getDepthMeta().values).toEqual([-0.5, -10, -100]);
    expect(z.getDepthMeta().current).toBe(-0.5);
  });

  it("requests vertical metadata for the active variable and hides absent dimensions", async () => {
    const vertical = vi.mocked(ZarrSource.prototype.getVerticalDimension);
    vertical.mockReturnValue(undefined);
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog(scalarLayer()) }, "scalar");

    expect(vertical).toHaveBeenCalledWith("temperature");
    expect(z.getDepthMeta().values).toEqual([]);
    expect(z.getDepthMeta().current).toBeUndefined();
  });

  it("forwards atomic time/depth changes to the active layer", async () => {
    const spy = vi.spyOn(CatalogRenderLayer.prototype, "setTimeAndDepth");
    const map = new FakeMap();
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");
    await z.update({ time: 4_000, depth: 20 });

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
    const z = await createZartigl({ source: "zarr", map: map as never, catalog: catalog() }, "scalar");
    await z.queryTimeSeries({ longitude: 1, latitude: 2, maxPoints: 3 });
    await z.queryDepthProfile({ longitude: 1, latitude: 2, maxDepths: 2 });

    expect(timeSpy).toHaveBeenCalledWith(expect.objectContaining({ stride: 4 }));
    expect(depthSpy).toHaveBeenCalledWith(expect.objectContaining({ maxDepths: 2 }));
  });

  it("filters absolute time ranges and constrains point-series queries", async () => {
    const timeSpy = vi
      .spyOn(ZarrSource.prototype, "sampleTimeSeries")
      .mockResolvedValue({ longitude: 0, latitude: 0, points: [] });
    const map = new FakeMap();
    const z = await createZartigl({
      source: "zarr",
      map: map as never,
      catalog: catalog(),
      timeRange: { start: 2_500, end: 7_500 },
    }, "scalar");
    expect(z.getTimeMeta()).toMatchObject({
      min: 3_000,
      max: 7_000,
      size: 5,
      values: [3_000, 4_000, 5_000, 6_000, 7_000],
      granularity: "second",
    });

    await z.update({ time: 9_000 });
    expect(z.getTimeMeta().current).toBe(7_000);
    await z.queryTimeSeries({ longitude: 1, latitude: 2, maxPoints: 2 });
    expect(timeSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeStartIndex: 3,
      timeEndIndex: 7,
      stride: 3,
    }));
  });

  it("applies, clears, and rolls back dynamic time ranges", async () => {
    const setRange = vi.spyOn(CatalogRenderLayer.prototype, "setTimeRange");
    const setTime = vi.spyOn(CatalogRenderLayer.prototype, "setTime");
    const z = await createZartigl({ source: "zarr", map: new FakeMap() as never, catalog: catalog() }, "scalar");
    await z.update({ time: 8_000 });

    await z.update({ timeRange: { start: 2_500, end: 6_500 } });
    expect(z.getTimeMeta()).toMatchObject({
      min: 3_000,
      max: 6_000,
      current: 6_000,
      values: [3_000, 4_000, 5_000, 6_000],
    });
    expect(z.getTimeMeta({ full: true })).toMatchObject({
      min: 0,
      max: 9_000,
      size: 10,
    });
    expect(setRange).toHaveBeenLastCalledWith([3_000, 6_000]);
    expect(setTime).toHaveBeenLastCalledWith(6_000);

    await expect(z.update({ timeRange: { start: 20_000, end: 30_000 } })).rejects.toThrow(
      /available timestamps/,
    );
    expect(z.getTimeMeta()).toMatchObject({ min: 3_000, max: 6_000, current: 6_000 });

    await z.update({ timeRange: null });
    expect(z.getTimeMeta()).toMatchObject({ min: 0, max: 9_000, size: 10 });
  });

  it("uses nested GeoVideo defaults and forwards runtime playback changes", async () => {
    const layer = scalarLayer({
      id: GEO_ENTRY_ID,
      zarrId: GEO_ZARR_ID,
      derived: {
        geoVideos: [{ id: GEO_VIDEO_ID, manifestUrl: "https://example.test/manifest.json" }],
      },
    });
    const manifest = {
      schemaVersion: 3,
      id: GEO_VIDEO_ID,
      type: "geovideo",
      projection: "equirectangular",
      bounds: [-180, -90, 180, 90],
      media: { url: "video.mp4", mimeType: "video/mp4", width: 16, height: 8, fps: 1, durationSeconds: 2, codec: "h264" },
      encoding: { kind: "scalar-luma", bits: 8, codeMin: 8, codeMax: 247, valueMin: 0, valueMax: 1, transfer: "linear", colorSpace: "bt709", colorRange: "limited" },
      mask: { kind: "static-validity", url: "mask.png", mimeType: "image/png", width: 16, height: 8, threshold: 0.5 },
      timeline: { kind: "snapshot-loop", date: "2026-01-01T00:00:00Z" },
      provenance: { catalogEntryId: GEO_ENTRY_ID, inputSourceId: GEO_ZARR_ID, variables: ["temperature"], generatedAt: "2026-01-01T00:00:00Z" },
      style: { palette: "balance", colorDomain: [0, 1], unit: "K" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }));
    const map = new FakeMap();
    const z = await createZartigl({
      map: map as never,
      catalog: catalog(layer),
      source: "geovideo",
      geoVideo: { autoplay: false, loop: false, playbackRate: 5 },
    }, GEO_ENTRY_ID);

    const arco = map.getLayer("zartigl") as unknown as {
      options: { geoVideoAutoplay: boolean; geoVideoLoop: boolean; geoVideoPlaybackRate: number };
    };
    expect(arco.options).toMatchObject({
      geoVideoAutoplay: false,
      geoVideoLoop: false,
      geoVideoPlaybackRate: 5,
    });
    expect(z.getTimeMeta()).toMatchObject({
      timelineKind: "snapshot-loop",
      size: 1,
    });
    const loop = vi.spyOn(CatalogRenderLayer.prototype, "setLoop");
    const rate = vi.spyOn(CatalogRenderLayer.prototype, "setPlaybackRate");
    await z.update({ geoVideo: { loop: true } });
    await z.update({ geoVideo: { playbackRate: 2 } });
    expect(loop).toHaveBeenCalledWith(true);
    expect(rate).toHaveBeenCalledWith(2);
    vi.unstubAllGlobals();
  });

  it("retains a time requested while GeoVideo metadata is loading", async () => {
    const layer = scalarLayer({
      id: GEO_ENTRY_ID,
      zarrId: GEO_ZARR_ID,
      derived: {
        geoVideos: [{ id: GEO_VIDEO_ID, manifestUrl: "https://example.test/manifest.json" }],
      },
    });
    const start = Date.parse("2026-01-01T00:00:00Z");
    const end = Date.parse("2026-03-01T00:00:00Z");
    const requested = start + (end - start) / 2;
    const manifest = {
      schemaVersion: 3,
      id: GEO_VIDEO_ID,
      type: "geovideo",
      projection: "equirectangular",
      bounds: [-180, -90, 180, 90],
      media: { url: "video.mp4", mimeType: "video/mp4", width: 16, height: 8, fps: 1, durationSeconds: 3, codec: "h264" },
      encoding: { kind: "scalar-luma", bits: 8, codeMin: 8, codeMax: 247, valueMin: 0, valueMax: 1, transfer: "linear", colorSpace: "bt709", colorRange: "limited" },
      mask: { kind: "static-validity", url: "mask.png", mimeType: "image/png", width: 16, height: 8, threshold: 0.5 },
      timeline: { kind: "range", dateStart: new Date(start).toISOString(), dateEnd: new Date(end).toISOString(), interpolation: "linear" },
      provenance: { catalogEntryId: GEO_ENTRY_ID, inputSourceId: GEO_ZARR_ID, variables: ["temperature"], generatedAt: "2026-01-01T00:00:00Z" },
      style: { palette: "balance", colorDomain: [0, 1], unit: "K" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => manifest,
    }));
    const map = new FakeMap();
    map.ready = false;
    const z = new Zartigl({
      map: map as never,
      catalog: catalog(layer),
      layer: GEO_ENTRY_ID,
      source: "geovideo",
      time: requested,
    });
    await z.init();

    expect(z.getTimeMeta().current).toBe(requested);
    vi.unstubAllGlobals();
  });

  it("supports trailing calendar ranges and infers monthly precision", async () => {
    const values = [
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-03-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    ].map((value) => new Date(value).getTime());
    vi.mocked(ZarrSource.prototype.getTimeDimension).mockReturnValue({
      min: values[0], max: values[values.length - 1], size: values.length,
      units: "milliseconds since 1970-01-01T00:00:00Z", values,
    });
    const z = await createZartigl({
      source: "zarr",
      map: new FakeMap() as never,
      catalog: catalog(),
      timeRange: { trailing: "P1M" },
    }, "scalar");

    expect(z.getTimeMeta()).toMatchObject({
      values: values.slice(2),
      granularity: "month",
    });
  });

  it("rejects invalid and empty time ranges", async () => {
    const invalid = new Zartigl({
      source: "zarr",
      map: new FakeMap() as never,
      catalog: catalog(),
      layer: "scalar",
      timeRange: { trailing: "P0D" },
    });
    await expect(invalid.init()).rejects.toThrow(/positive/);

    const empty = new Zartigl({
      source: "zarr",
      map: new FakeMap() as never,
      catalog: catalog(),
      layer: "scalar",
      timeRange: { start: 20_000, end: 30_000 },
    });
    await expect(empty.init()).rejects.toThrow(/available timestamps/);
  });

  it("lets the latest concurrent layer update win without leaking staged state", async () => {
    const first = scalarLayer();
    const second = scalarLayer({ id: "second" });
    const third = scalarLayer({ id: "third" });
    const z = await createZartigl({
      source: "zarr",
      map: new FakeMap() as never,
      catalog: { schemaVersion: 2, defaultLocale: "en", layers: [first, second, third] },
    }, "scalar");
    let releaseSecond!: () => void;
    vi.mocked(ZarrSource.prototype.init).mockClear();
    vi.mocked(ZarrSource.prototype.init)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSecond = resolve; }))
      .mockResolvedValueOnce();

    const superseded = z.update({ layer: "second", source: "zarr", settings: { opacity: 0.2 } });
    await Promise.resolve();
    await z.update({ layer: "third", source: "zarr", settings: { opacity: 0.8 } });
    releaseSecond();

    await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
    expect(z.getDebugInfo()).toMatchObject({
      catalogEntry: { id: "third" },
      settings: { opacity: 0.8 },
    });
  });

  it("loads a replacement source with its replacement time range", async () => {
    const firstValues = [0, 1_000, 2_000];
    const secondValues = [10_000, 11_000, 12_000];
    const base = scalarLayer();
    const firstSource = base.sources.find((source) => source.type === "zarr")!;
    const secondSource = {
      ...firstSource,
      id: "second-zarr",
      endpoints: { ...firstSource.endpoints, field: "https://example.test/second.zarr" },
    };
    const layer = { ...base, sources: [firstSource, secondSource] } as CatalogEntry;
    vi.mocked(ZarrSource.prototype.getTimeDimension)
      .mockReturnValueOnce({
        min: firstValues[0], max: firstValues[2], size: firstValues.length,
        units: "milliseconds since 1970-01-01T00:00:00Z", values: firstValues,
      })
      .mockReturnValueOnce({
        min: secondValues[0], max: secondValues[2], size: secondValues.length,
        units: "milliseconds since 1970-01-01T00:00:00Z", values: secondValues,
      });
    const z = await createZartigl({
      source: firstSource.id,
      map: new FakeMap() as never,
      catalog: catalog(layer),
      timeRange: { start: 0, end: 2_000 },
    }, layer.id);

    await z.update({
      source: secondSource.id,
      timeRange: { start: 10_000, end: 12_000 },
    });

    expect(z.getSource()?.id).toBe(secondSource.id);
    expect(z.getTimeMeta()).toMatchObject({
      min: 10_000,
      max: 12_000,
      values: secondValues,
    });
  });

  it("preserves mutations queued during a layer metadata load", async () => {
    const first = scalarLayer();
    const second = scalarLayer({
      id: "second",
      stores: { field: { url: "https://example.test/second.zarr" } },
    });
    const z = await createZartigl({
      source: "zarr",
      map: new FakeMap() as never,
      catalog: { schemaVersion: 2, defaultLocale: "en", layers: [first, second] },
    }, first.id);
    let releaseMetadata!: () => void;
    vi.mocked(ZarrSource.prototype.init).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseMetadata = resolve; }),
    );

    const select = z.update({ layer: second.id, source: "zarr", settings: { opacity: 0.2 } });
    await Promise.resolve();
    const settings = z.update({ settings: { opacity: 0.8 } });
    const time = z.update({ time: 4_000 });
    const depth = z.update({ depth: 20 });
    const visibility = z.update({ visible: false });
    releaseMetadata();
    await Promise.all([select, settings, time, depth, visibility]);

    expect(z.getDebugInfo()).toMatchObject({
      catalogEntry: { id: second.id },
      settings: { opacity: 0.8 },
      time: 4_000,
      depth: 20,
      visible: false,
    });
  });

  it("preserves the active layer when candidate metadata loading fails", async () => {
    const first = scalarLayer();
    const second = {
      ...scalarLayer(),
      id: "second",
      sources: scalarLayer().sources.map((source) => source.type === "zarr"
        ? { ...source, endpoints: { ...source.endpoints, field: "https://example.test/second.zarr" } }
        : source),
    } as CatalogEntry;
    const map = new FakeMap();
    const z = new Zartigl({
      source: "zarr",
      map: map as never,
      catalog: { schemaVersion: 2, defaultLocale: "en", layers: [first, second] },
      layer: "scalar",
    });
    const errors: Error[] = [];
    z.on("error", (error) => errors.push(error));

    await z.init();
    const active = map.getLayer("zartigl");
    vi.mocked(ZarrSource.prototype.init).mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(z.update({ layer: "second", source: "zarr" })).rejects.toThrow("metadata unavailable");
    expect(map.getLayer("zartigl")).toBe(active);
    expect(z.getTimeMeta().current).toBe(9_000);
    expect(errors[errors.length - 1]?.message).toBe("metadata unavailable");
  });
});
