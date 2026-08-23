import { describe, expect, it } from "vitest";
import storyJson from "../story.json";
import viewsJson from "../views.json";
import { parseStoryDocuments, resolveLocalizedText, validateStoryDocument } from "./document";

describe("story documents", () => {
  it("accepts the migrated story and view registry", () => {
    const documents = parseStoryDocuments(storyJson, viewsJson);
    expect(documents.story.scenes).toHaveLength(5);
    expect(documents.views.views).toHaveLength(5);
    expect(documents.story.scenes.find((scene) => scene.id === "arctic")?.blocks)
      .toContainEqual(expect.objectContaining({ type: "copy", backdrop: "dark-gradient" }));
  });

  it("rejects an unknown copy backdrop", () => {
    const invalid = structuredClone(storyJson) as unknown as {
      scenes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    const copy = invalid.scenes[1].blocks.find((block) => block.type === "copy");
    if (!copy) throw new Error("Fixture copy block is missing");
    copy.backdrop = "frosted-glass";
    expect(() => validateStoryDocument(invalid)).toThrow(/backdrop is invalid/);
  });

  it("rejects duplicate scene ids", () => {
    const invalid = structuredClone(storyJson) as unknown as { scenes: Array<{ id: string }> };
    invalid.scenes[1].id = invalid.scenes[0].id;
    expect(() => validateStoryDocument(invalid)).toThrow(/duplicated/);
  });

  it("rejects a missing view reference", () => {
    const invalid = structuredClone(viewsJson) as unknown as { views: Array<{ id: string }> };
    invalid.views = invalid.views.filter((view) => view.id !== "enso-pacific");
    expect(() => parseStoryDocuments(storyJson, invalid)).toThrow(/unknown view enso-pacific/);
  });

  it("uses locale fallbacks deterministically", () => {
    expect(resolveLocalizedText({ en: "Ocean", fr: "Océan" }, "de", "en", ["fr"])).toBe("Océan");
  });

  it("rejects the removed scroll-scrub playback mode", () => {
    const invalid = structuredClone(storyJson) as unknown as { scenes: Array<{ playback: { mode: string } }> };
    invalid.scenes[0].playback.mode = "scrub";
    expect(() => validateStoryDocument(invalid)).toThrow(/playback.mode is invalid/);
  });

  it("rejects the removed scroll length property", () => {
    const invalid = structuredClone(storyJson) as unknown as { scenes: Array<Record<string, unknown>> };
    invalid.scenes[0].scrollVh = 180;
    expect(() => validateStoryDocument(invalid)).toThrow(/scrollVh is not supported/);
  });
});
