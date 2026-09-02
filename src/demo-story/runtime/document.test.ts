import { describe, expect, it } from "vitest";
import storyJson from "../story.json";
import viewsJson from "../views.json";
import { parseStoryDocuments, resolveLocalizedText, validateStoryDocument } from "./document";
import { storyExternalLinkAttributes } from "./externalLinks";
import type { StoryCopyBlock, StoryWidgetBlock } from "./types";

describe("story documents", () => {
  it("accepts the migrated story and view registry", () => {
    const documents = parseStoryDocuments(storyJson, viewsJson);
    expect(documents.story.scenes).toHaveLength(6);
    expect(documents.views.views).toHaveLength(6);
    expect(documents.story.scenes.find((scene) => scene.id === "arctic")?.blocks)
      .toContainEqual(expect.objectContaining({ type: "copy", backdrop: "dark-gradient" }));
    expect(documents.story.scenes.find((scene) => scene.id === "baltic")?.blocks)
      .toContainEqual(expect.objectContaining({ type: "widget", widget: "baltic-hypoxia" }));
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

  it("accepts and localizes scientific references and widget captions", () => {
    const documents = parseStoryDocuments(storyJson, viewsJson);
    const arctic = documents.story.scenes.find((scene) => scene.id === "arctic")!;
    const copy = arctic.blocks.find((block): block is StoryCopyBlock => block.type === "copy")!;
    const widget = arctic.blocks.find((block): block is StoryWidgetBlock => block.type === "widget")!;

    expect(resolveLocalizedText(copy.heading, "fr", "en")).toBe("Perte de glace arctique");
    expect(resolveLocalizedText(copy.text!, "en", "en")).toContain("12.8% per decade");
    expect(resolveLocalizedText(widget.caption!, "fr", "en")).toContain("391 valeurs");
    expect(resolveLocalizedText(widget.caption!, "de", "en")).toContain("391 values");
    expect(copy.references?.[0].url).toMatch(/^https:\/\//);
  });

  it("rejects malformed references and captions", () => {
    const invalidReference = structuredClone(storyJson) as unknown as {
      scenes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    const copy = invalidReference.scenes[1].blocks.find((block) => block.type === "copy")!;
    copy.references = [{ label: { en: "Unsafe" }, url: "javascript:alert(1)" }];
    expect(() => validateStoryDocument(invalidReference)).toThrow(/must use HTTP or HTTPS/);

    const invalidCaption = structuredClone(storyJson) as unknown as {
      scenes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    const widget = invalidCaption.scenes[1].blocks.find((block) => block.type === "widget")!;
    widget.caption = "Not localized";
    expect(() => validateStoryDocument(invalidCaption)).toThrow(/caption must be a localized object/);
  });

  it("builds safe attributes for external scientific links", () => {
    expect(storyExternalLinkAttributes(
      { label: { en: "IPCC" }, url: "https://www.ipcc.ch/report/" },
      "IPCC",
    )).toEqual({
      href: "https://www.ipcc.ch/report/",
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: "IPCC",
    });
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
