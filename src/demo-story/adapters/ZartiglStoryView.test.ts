import { describe, expect, it } from "vitest";
import { resolveCameraTransition } from "./ZartiglStoryView";

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
