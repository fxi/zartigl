import { describe, expect, it } from "vitest";
import { parseProjversorView } from "../projversor";
import { parseStoryDocuments, sceneViewId } from "../story";
import { LAYOUT_IDS, isLayoutId } from "./layout";
import storyJson from "./story.json";
import viewsJson from "./views.json";

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
