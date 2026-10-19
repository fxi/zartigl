import { describe, expect, it } from "vitest";
import { COLOR_GRADE_OFF, COLOR_GRADE_VIBRANT } from "../engine";
import { parseStoryDocuments, sceneViewId } from "../story";
import {
  parseProjversorView,
  projversorState,
} from "./adapters/ProjversorStoryView";
import { LAYOUT_IDS, isLayoutId } from "./layout";
import storyJson from "./story.json";
import viewsJson from "./views.json";

const view = (config: Record<string, unknown>) => ({
  id: "probe",
  type: "projversor",
  config: { layer: "surface-wind", preset: "globe", ...config },
});

describe("projversor story documents", () => {
  const { story, views } = parseStoryDocuments(storyJson, viewsJson, {
    layouts: LAYOUT_IDS,
  });
  const words = (text = "") => text.split(/\s+/).filter(Boolean).length;

  it("keeps the copy short: a hook of up to 5 words, at most 35 words of text", () => {
    for (const scene of story.scenes) {
      expect(isLayoutId(scene.layout)).toBe(true);
      const copy = scene.blocks.find((b) => b.type === "copy");
      if (copy?.type !== "copy") {
        continue;
      }
      for (const locale of ["en", "fr"]) {
        expect(words(copy.heading[locale])).toBeLessThanOrEqual(5);
        expect(words(copy.text?.[locale])).toBeLessThanOrEqual(35);
      }
    }
  });

  it("gives every scene a projversor view, a duration and copy in en and fr", () => {
    const ids = new Set(views.views.map((v) => v.id));
    for (const scene of story.scenes) {
      expect(ids.has(sceneViewId(scene)!)).toBe(true);
      expect(scene.durationMs).toBeGreaterThan(0);
      const copy = scene.blocks.find((b) => b.type === "copy");
      expect(copy?.type).toBe("copy");
      if (copy?.type === "copy") {
        expect(copy.heading.en && copy.heading.fr).toBeTruthy();
        expect(copy.text?.en && copy.text?.fr).toBeTruthy();
      }
    }
  });

  it("only uses projversor layers, presets, palettes and tints", () => {
    for (const definition of views.views) {
      expect(definition.type).toBe("projversor");
      expect(() => parseProjversorView(definition)).not.toThrow();
    }
  });
});

describe("parseProjversorView", () => {
  it("rejects unknown layers, presets and palettes", () => {
    expect(() => parseProjversorView(view({ layer: "nope" }))).toThrow(/layer/);
    expect(() => parseProjversorView(view({ preset: "nope" }))).toThrow(
      /preset/,
    );
    expect(() => parseProjversorView(view({ palette: "nope" }))).toThrow(
      /palette/,
    );
  });

  it("rejects malformed numbers, dates and tints", () => {
    expect(() => parseProjversorView(view({ rotate: [0, 0] }))).toThrow(
      /rotate/,
    );
    expect(() => parseProjversorView(view({ zoom: 0 }))).toThrow(/zoom/);
    // A speed the renderer would silently ignore for this layer kind.
    expect(() => parseProjversorView(view({ speed: 3 }))).toThrow(/speed/);
    expect(() => parseProjversorView(view({ time: "soon" }))).toThrow(/time/);
    expect(() =>
      parseProjversorView(
        view({ layer: "sea-ice-thickness", preset: "north", tint: "" }),
      ),
    ).toThrow(/tint/);
  });

  it("maps a config to the projversor state", () => {
    const state = projversorState(
      parseProjversorView(
        view({ time: "2025-01-15T00:00:00Z", vibrant: true, tint: "" }),
      ),
    );
    expect(state).toMatchObject({
      layer: "surface-wind",
      preset: "globe",
      tint: "",
      time: Date.parse("2025-01-15T00:00:00Z"),
      grade: COLOR_GRADE_VIBRANT,
    });
    expect(projversorState(parseProjversorView(view({}))).grade).toBe(
      COLOR_GRADE_OFF,
    );
  });
});
