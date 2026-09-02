import { describe, expect, it, vi } from "vitest";
import {
  arcticMeasurementFeature,
  nearestChidoTrackPoint,
  resolveCameraTransition,
  storyOverlayVisibility,
  ZartiglStoryView,
} from "./ZartiglStoryView";
import { Zartigl } from "../../lib";

class FakeStoryMap {
  private layers = new Map<string, unknown>();
  on(): void {}
  off(): void {}
  addSource(): void {}
  addLayer(layer: { id: string }): void { this.layers.set(layer.id, layer); }
  getLayer(id: string): unknown { return this.layers.get(id); }
  getSource(): undefined { return undefined; }
  setLayoutProperty(): void {}
  setFilter(): void {}
  moveLayer(): void {}
  stop(): void {}
  flyTo(): void {}
  jumpTo(): void {}
  isStyleLoaded(): boolean { return false; }
}

describe("story reference overlays", () => {
  it("formats the returned Arctic grid point for its map target", () => {
    const feature = arcticMeasurementFeature({ latitude: 81.833, longitude: -5.667 });

    expect(feature.geometry.coordinates).toEqual([-5.667, 81.833]);
    expect(feature.properties?.label).toBe("81.833°N · 5.667°W");
  });

  it("shows only overlays configured for the active view", () => {
    expect(storyOverlayVisibility(["arctic-measurement"])).toEqual({
      arcticMeasurement: true,
      ensoRegions: false,
      chidoTrack: false,
    });
    expect(storyOverlayVisibility([])).toEqual({
      arcticMeasurement: false,
      ensoRegions: false,
      chidoTrack: false,
    });
  });

  it("selects the track point nearest the requested time", () => {
    const points = [
      { time: "2024-01-01T00:00:00.000Z", label: "first", longitude: 1, latitude: 2 },
      { time: "2024-01-01T03:00:00.000Z", label: "second", longitude: 3, latitude: 4 },
    ];

    expect(nearestChidoTrackPoint(points, Date.parse("2024-01-01T02:30:00.000Z")).label)
      .toBe("second");
  });
});

describe("resolveCameraTransition", () => {
  it("always resolves the exact target camera for a scene", () => {
    const arctic = resolveCameraTransition({
      camera: { center: [-5.667, 81.833], zoom: 2.35, pitch: 0, bearing: 0 },
      anchor: "top-right",
      transition: { method: "flyTo", durationMs: 1400 },
    }, { width: 1000, height: 800 }, false);
    const enso = resolveCameraTransition({
      camera: { center: [-145, 0], zoom: 1.55, pitch: 0, bearing: 0 },
      anchor: "top-right",
      transition: { method: "flyTo", durationMs: 900 },
    }, { width: 1000, height: 800 }, false);

    expect(arctic.options.center).toEqual([-5.667, 81.833]);
    expect(enso.options.center).toEqual([-145, 0]);
    expect(enso.options.duration).toBe(900);
    expect(enso.options.padding).toEqual({ top: 0, right: 0, bottom: 192, left: 440 });
  });

  it("uses an immediate target for reduced motion", () => {
    const transition = resolveCameraTransition({
      camera: { center: [22, 8], zoom: 1.2 },
      transition: { method: "flyTo", durationMs: 1400 },
    }, { width: 1000, height: 800 }, true);

    expect(transition.method).toBe("jumpTo");
    expect(transition.options.duration).toBe(0);
    expect(transition.options.center).toEqual([22, 8]);
  });

  it("reserves the lower canvas for copy and analysis in portrait viewports", () => {
    const transition = resolveCameraTransition({
      camera: { center: [-145, 0], zoom: 1.55 },
      anchor: "top-right",
    }, { width: 390, height: 844 }, false);

    expect(transition.options.padding).toEqual({ top: 0, right: 0, bottom: 287, left: 62 });
  });
});

describe("ZartiglStoryView activation", () => {
  it("waits for the initial init before applying the latest scene", async () => {
    let releaseInit!: () => void;
    const init = vi.spyOn(Zartigl.prototype, "init").mockImplementation(
      () => new Promise<void>((resolve) => { releaseInit = resolve; }),
    );
    const update = vi.spyOn(Zartigl.prototype, "update").mockResolvedValue();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
    const adapter = new ZartiglStoryView(new FakeStoryMap() as never, {
      status: () => undefined,
      time: () => undefined,
    });
    const first = adapter.activate({
      id: "first",
      type: "zartigl-map",
      config: {
        layerId: "a7d9835c-0a80-4112-8b43-694e359384ac",
        sourceId: "f5b31e02-ff0f-4310-a046-a781bd2b1c38",
        camera: { center: [0, 80], zoom: 1 },
      },
    }, {} as never);
    await Promise.resolve();

    const second = adapter.activate({
      id: "second",
      type: "zartigl-map",
      config: {
        layerId: "5e94f1b2-1342-4a1f-936e-09170d7d4db8",
        sourceId: "e260c26f-8374-4c65-a076-5cd181ed5091",
        camera: { center: [-140, 0], zoom: 2 },
      },
    }, {} as never);
    await Promise.resolve();

    expect(init).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    releaseInit();
    await Promise.all([first, second]);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      layer: "5e94f1b2-1342-4a1f-936e-09170d7d4db8",
      source: "e260c26f-8374-4c65-a076-5cd181ed5091",
      visible: true,
    }));
    init.mockRestore();
    update.mockRestore();
    vi.unstubAllGlobals();
  });
});
