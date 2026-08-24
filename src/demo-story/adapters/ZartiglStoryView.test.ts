import { describe, expect, it } from "vitest";
import { arcticMeasurementFeature, resolveCameraTransition, storyOverlayVisibility } from "./ZartiglStoryView";

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
