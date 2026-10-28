import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogRenderLayer,
  buildWmtsLegendUrl,
  buildWmtsTileUrl,
  resolveWmtsTileTemplate,
  selectCatalogRenderLayerBackend,
} from "./CatalogRenderLayer";
import type {
  CatalogEntry,
  CatalogGeoVideoSource,
  CatalogSource,
  CatalogWmtsSource,
  CatalogZarrSource,
} from "../catalog/types";
import type { CatalogRenderLayerOptions } from "./types";
import { geoVideoTimelineValues } from "./geovideo";
import { GeoVideoVectorSource } from "./GeoVideoVectorSource";
import { ParticleSimulation } from "./ParticleSimulation";
import { vectorManifest, geoVideoTestGl, flushFrames } from "./test-geovideo";
import { VectorLayer } from "./VectorLayer";

const zarr: CatalogZarrSource = {
  id: "zarr",
  type: "zarr",
  title: { en: "Zarr" },
  endpoints: { field: "https://example.test/scalar.zarr" },
  variables: { kind: "scalar", value: "chl" },
};
const wmts: CatalogWmtsSource = {
  id: "wmts",
  type: "wmts",
  title: { en: "WMTS" },
  capabilitiesUrl: "https://example.test/capabilities",
  baseUrl: "https://example.test/wmts",
  layer: "PRODUCT/DATASET/chl",
  tileMatrixSet: "EPSG:3857",
  format: "image/png",
  style: "cmap:algae,logScale",
};
const video: CatalogGeoVideoSource = {
  id: "video",
  type: "geovideo",
  title: { en: "Video" },
  manifestUrl: "https://example.test/manifest.json",
};
const entry: CatalogEntry = {
  id: "entry",
  title: { en: "Scalar" },
  category: "test",
  kind: "scalar",
  sources: [zarr, wmts, video],
  defaults: { sourceId: zarr.id },
};
function options(
  sourceConfig: CatalogSource = zarr,
  extra: Partial<CatalogRenderLayerOptions> = {},
): CatalogRenderLayerOptions {
  return { id: "layer", entry, sourceConfig, ...extra };
}

describe("WMTS URL helpers", () => {
  it("builds KVP tile URLs without encoding MapLibre placeholders", () => {
    const url = buildWmtsTileUrl({
      baseUrl: wmts.baseUrl!,
      layer: wmts.layer,
      tileMatrixSet: wmts.tileMatrixSet!,
      format: wmts.format!,
      style: wmts.style,
      time: Date.UTC(2026, 5, 4),
      depth: 0.5,
      verticalLabel: "depth",
    });
    expect(url).toContain("TILEMATRIX={z}");
    expect(url).toContain("LAYER=PRODUCT%2FDATASET%2Fchl");
    expect(url).toContain("time=2026-06-04T00%3A00%3A00.000Z");
    expect(url).toContain("elevation=-0.5");
  });

  it("builds a server legend URL", () => {
    expect(
      buildWmtsLegendUrl({
        baseUrl: wmts.baseUrl!,
        layer: wmts.layer,
        style: wmts.style,
      }),
    ).toContain("REQUEST=GetLegend");
  });

  it("resolves REST template dimensions while preserving tile placeholders", () => {
    const url = resolveWmtsTileTemplate({
      template:
        "https://tiles.test/{TileMatrix}/{TileRow}/{TileCol}?time={Time}&elevation={elevation}",
      tileMatrixSet: "EPSG:3857",
      style: "default",
      time: Date.UTC(2026, 5, 4),
      depth: 12,
      verticalLabel: "depth",
    });
    expect(url).toBe(
      "https://tiles.test/{z}/{y}/{x}?time=2026-06-04T00%3A00%3A00.000Z&elevation=-12",
    );
  });

  it("falls back when a REST template still contains an unknown placeholder", () => {
    expect(
      resolveWmtsTileTemplate({
        template: "https://tiles.test/{z}/{unknown}",
        time: 1,
      }),
    ).toBeUndefined();
  });
});

describe("source dispatch", () => {
  it("selects the renderer from the discriminated source", () => {
    expect(selectCatalogRenderLayerBackend(options(zarr))).toBe("scalar-zarr");
    expect(selectCatalogRenderLayerBackend(options(wmts))).toBe("scalar-wmts");
    expect(selectCatalogRenderLayerBackend(options(video))).toBe(
      "scalar-geovideo",
    );
    const vectorSource: CatalogZarrSource = {
      ...zarr,
      variables: { kind: "vector", u: "u", v: "v" },
    };
    const vectorEntry: CatalogEntry = {
      ...entry,
      kind: "vector",
      sources: [vectorSource],
    };
    expect(
      selectCatalogRenderLayerBackend({
        ...options(vectorSource),
        entry: vectorEntry,
      }),
    ).toBe("vector-zarr");
    expect(
      selectCatalogRenderLayerBackend({
        ...options(video),
        entry: { ...vectorEntry, sources: [vectorSource, video] },
      }),
    ).toBe("vector-geovideo");
  });

  it("detaches WMTS while suspended and restores the latest time", () => {
    const layers = new Map<string, unknown>(),
      sources = new Map<string, unknown>();
    const map = {
      addLayer: (value: { id: string }) => layers.set(value.id, value),
      removeLayer: (id: string) => layers.delete(id),
      getLayer: (id: string) => layers.get(id),
      addSource: (id: string, value: unknown) => sources.set(id, value),
      removeSource: (id: string) => sources.delete(id),
      getSource: (id: string) => sources.get(id),
    };
    const layer = new CatalogRenderLayer(options(wmts, { time: 1_000 }));
    layer.onAdd(map as never, {} as never);
    layer.suspend();
    layer.setTime(2_000);
    expect(sources.has("layer-wmts-source")).toBe(false);
    layer.resume();
    expect(
      (sources.get("layer-wmts-source") as { tiles: string[] }).tiles[0],
    ).toContain(encodeURIComponent(new Date(2_000).toISOString()));
  });
  it("keeps the WMTS raster right above its custom layer", () => {
    const order = ["below", "layer", "above"];
    const map = {
      addLayer: (value: { id: string }, before?: string) =>
        order.splice(
          before ? order.indexOf(before) : order.length,
          0,
          value.id,
        ),
      removeLayer: (id: string) => order.splice(order.indexOf(id), 1),
      getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
      getLayersOrder: () => [...order],
      addSource: () => {},
      removeSource: () => {},
      getSource: () => undefined,
    };
    const layer = new CatalogRenderLayer(options(wmts, { time: 1_000 }));
    layer.onAdd(map as never, {} as never);
    layer.setTime(2_000);
    expect(order).toEqual(["below", "layer", "layer-wmts", "above"]);
  });
});

describe("vector GeoVideo playback", () => {
  const times = geoVideoTimelineValues(vectorManifest);
  const frame = {
    u: new Float32Array(128).fill(1),
    v: new Float32Array(128).fill(-0.5),
  };
  const vectorEntry: CatalogEntry = {
    ...entry,
    kind: "vector",
    sources: [video],
  };

  beforeEach(() => {
    vi.spyOn(GeoVideoVectorSource.prototype, "frame").mockResolvedValue(frame);
    vi.spyOn(ParticleSimulation.prototype, "init").mockImplementation(() => {});
    vi.spyOn(ParticleSimulation.prototype, "resize").mockImplementation(
      () => {},
    );
    vi.spyOn(ParticleSimulation.prototype, "render").mockImplementation(
      () => {},
    );
    vi.spyOn(ParticleSimulation.prototype, "destroy").mockImplementation(
      () => {},
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function setup() {
    const { gl } = geoVideoTestGl();
    Object.assign(gl, { canvas: { width: 800, height: 600 } });
    const map = {
      on: vi.fn(),
      off: vi.fn(),
      triggerRepaint: vi.fn(),
      getLayer: vi.fn(),
      getSource: vi.fn(),
      getProjection: () => ({ type: "globe" }),
      getZoom: () => 2,
      getCenter: () => ({ lng: 0, lat: 0 }),
      getBounds: () => ({
        getWest: () => -180,
        getEast: () => 180,
        getSouth: () => -80,
        getNorth: () => 80,
      }),
    };
    const layer = new CatalogRenderLayer({
      ...options(video),
      entry: vectorEntry,
      time: times[0],
      geoVideoManifest: vectorManifest,
      geoVideoLoop: false,
      geoVideoStepsPerSecond: 2,
      geoVideoTimeRange: [times[0], times[2]],
    });
    const events = {
      timeChange: vi.fn(),
      playbackChange: vi.fn(),
      playbackEnd: vi.fn(),
      error: vi.fn(),
      loaded: vi.fn(),
    };
    for (const [name, fn] of Object.entries(events)) {
      layer.on(name as keyof typeof events, fn);
    }
    await layer.onAdd(map as never, gl);
    await flushFrames();
    const render = async (now: number) => {
      vi.spyOn(performance, "now").mockReturnValue(now);
      layer.render(gl, {
        modelViewProjectionMatrix: new Float32Array(16),
        defaultProjectionData: { clippingPlane: [0, 0, 1, 0] },
      } as never);
      await flushFrames();
    };
    return { layer, events, render };
  }

  it("advances on renders and sends physical pairs and fractions to the simulation", async () => {
    const { layer, events, render } = await setup();
    const setTime = vi.spyOn(VectorLayer.prototype, "setTime");
    await layer.play();
    await render(0);
    await render(250);
    const calls = vi.mocked(ParticleSimulation.prototype.render).mock.calls;
    expect(calls[calls.length - 1][11]).toEqual({
      a: {
        unit: 1,
        min: [-2, -2],
        max: [2, 2],
        physical: true,
        northToSouth: true,
      },
      b: {
        unit: 4,
        min: [-2, -2],
        max: [2, 2],
        physical: true,
        northToSouth: true,
      },
      mix: 0.5,
    });
    await render(500);
    await render(750);
    await render(1000);
    await render(1500);
    expect(events.timeChange.mock.calls).toEqual([
      [times[0]],
      [times[1]],
      [times[2]],
    ]);
    expect(events.playbackChange.mock.calls).toEqual([[true], [false]]);
    expect(events.playbackEnd).toHaveBeenCalledOnce();
    expect(setTime).not.toHaveBeenCalled();
    layer.onRemove();
  });

  it("pauses on an exact step and resumes at the changed cadence", async () => {
    const { layer, render } = await setup();
    await layer.play();
    await render(0);
    await render(250);
    layer.pause();
    await flushFrames();
    await render(300);
    let calls = vi.mocked(ParticleSimulation.prototype.render).mock.calls;
    expect(calls[calls.length - 1][11]?.mix).toBe(0);
    layer.setStepsPerSecond(1);
    await layer.play();
    await render(1000);
    await render(1250);
    calls = vi.mocked(ParticleSimulation.prototype.render).mock.calls;
    expect(calls[calls.length - 1][11]?.mix).toBe(0.25);
    layer.onRemove();
  });

  it("stops and reports a decode failure while retaining the displayed pair", async () => {
    const { layer, events, render } = await setup();
    const failure = new Error("decode failed");
    vi.mocked(GeoVideoVectorSource.prototype.frame).mockRejectedValue(failure);
    await layer.play();
    await render(0);
    await render(500);
    expect(events.playbackChange.mock.calls).toEqual([[true], [false]]);
    expect(events.error).toHaveBeenCalledWith(failure);
    expect(ParticleSimulation.prototype.render).toHaveBeenCalled();
    layer.onRemove();
  });

  it("preloads and replaces a chunk in place, preserving playing state and the next-preload signal", async () => {
    const { layer, events, render } = await setup();
    const next = {
      ...vectorManifest,
      media: { ...vectorManifest.media, url: "next.mp4" },
    };
    expect(layer.preloadGeoVideoManifest(next, { time: times[3] })).toBe(true);
    await flushFrames();
    await layer.play();
    await render(0);
    await render(1500);
    expect(events.playbackEnd).toHaveBeenCalledOnce();
    expect(events.playbackChange.mock.calls).toEqual([[true]]);
    expect(
      layer.replaceGeoVideoManifest(next, {
        time: times[3],
        stepsPerSecond: 1,
      }),
    ).toBe(true);
    await flushFrames();
    await render(2000);
    await render(2250);
    expect(events.loaded).toHaveBeenCalledTimes(2);
    expect(events.playbackChange.mock.calls).toEqual([[true], [true]]);
    const calls = vi.mocked(ParticleSimulation.prototype.render).mock.calls;
    expect(calls[calls.length - 1][11]?.mix).toBe(0.25);
    layer.onRemove();
  });
});
