import { describe, expect, it } from "vitest";
import storyJson from "../story.json";
import viewsJson from "../views.json";
import { parseStoryDocuments, resolveLocalizedText, validateStoryDocument } from "./document";
import { storyExternalLinkAttributes } from "./externalLinks";
import type { StoryCopyBlock, StoryDocument, StoryViewsDocument, StoryWidgetBlock } from "./types";

function storyFixture(): StoryDocument {
  return {
    schemaVersion: 1,
    defaultLocale: "en",
    title: { en: "Fixture story" },
    themes: {
      fixture: {
        background: "#000",
        foreground: "#fff",
        muted: "#aaa",
        accent: "#0ff",
        accentSoft: "#044",
        surface: "#111",
      },
    },
    scenes: [
      {
        id: "scene-one",
        name: { en: "Scene one" },
        theme: "fixture",
        layout: "full",
        playback: { mode: "none" },
        blocks: [
          {
            id: "copy-one",
            type: "copy",
            slot: "copy",
            heading: { en: "Heading", fr: "Titre" },
            text: { en: "Body", fr: "Texte" },
            backdrop: "dark-gradient",
            references: [{ label: { en: "Source" }, url: "https://example.com/source" }],
          },
          {
            id: "widget-one",
            type: "widget",
            slot: "analysis",
            widget: "fixture-widget",
            caption: { en: "Caption", fr: "Légende" },
          },
          { id: "view-one", type: "view", slot: "stage", view: "fixture-view" },
        ],
      },
      {
        id: "scene-two",
        name: { en: "Scene two" },
        theme: "fixture",
        layout: "overlay",
        blocks: [],
      },
    ],
  };
}

function viewsFixture(): StoryViewsDocument {
  return {
    schemaVersion: 1,
    views: [{ id: "fixture-view", type: "fixture", config: {} }],
  };
}

describe("story documents", () => {
  it("loads the current story and view registry", () => {
    expect(() => parseStoryDocuments(storyJson, viewsJson)).not.toThrow();
  });

  it("accepts optional references and widget captions", () => {
    const documents = parseStoryDocuments(storyFixture(), viewsFixture());
    const blocks = documents.story.scenes[0].blocks;
    const copy = blocks.find((block): block is StoryCopyBlock => block.type === "copy")!;
    const widget = blocks.find((block): block is StoryWidgetBlock => block.type === "widget")!;

    expect(resolveLocalizedText(copy.heading, "fr", "en")).toBe("Titre");
    expect(resolveLocalizedText(widget.caption!, "fr", "en")).toBe("Légende");
    expect(copy.references?.[0].url).toBe("https://example.com/source");
  });

  it("rejects an unknown copy backdrop", () => {
    const invalid = structuredClone(storyFixture()) as unknown as {
      scenes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    invalid.scenes[0].blocks[0].backdrop = "frosted-glass";
    expect(() => validateStoryDocument(invalid)).toThrow(/backdrop is invalid/);
  });

  it("rejects duplicate scene ids", () => {
    const invalid = structuredClone(storyFixture());
    invalid.scenes[1].id = invalid.scenes[0].id;
    expect(() => validateStoryDocument(invalid)).toThrow(/duplicated/);
  });

  it("rejects a missing view reference", () => {
    const invalid = viewsFixture();
    invalid.views = [];
    expect(() => parseStoryDocuments(storyFixture(), invalid)).toThrow(/unknown view fixture-view/);
  });

  it("uses locale fallbacks deterministically", () => {
    expect(resolveLocalizedText({ en: "Default", fr: "Fallback" }, "de", "en", ["fr"]))
      .toBe("Fallback");
  });

  it("rejects malformed references and captions", () => {
    const invalidReference = structuredClone(storyFixture()) as unknown as {
      scenes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    invalidReference.scenes[0].blocks[0].references = [
      { label: { en: "Unsafe" }, url: "javascript:alert(1)" },
    ];
    expect(() => validateStoryDocument(invalidReference)).toThrow(/must use HTTP or HTTPS/);

    const invalidCaption = structuredClone(storyFixture()) as unknown as {
      scenes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    invalidCaption.scenes[0].blocks[1].caption = "Not localized";
    expect(() => validateStoryDocument(invalidCaption)).toThrow(/caption must be a localized object/);
  });

  it("builds safe attributes for external links", () => {
    expect(storyExternalLinkAttributes(
      { label: { en: "Source" }, url: "https://example.com/source" },
      "Source",
    )).toEqual({
      href: "https://example.com/source",
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: "Source",
    });
  });

  it("rejects the removed scroll-scrub playback mode", () => {
    const invalid = structuredClone(storyFixture()) as unknown as {
      scenes: Array<{ playback: { mode: string } }>;
    };
    invalid.scenes[0].playback.mode = "scrub";
    expect(() => validateStoryDocument(invalid)).toThrow(/playback.mode is invalid/);
  });

  it("rejects the removed scroll length property", () => {
    const invalid = structuredClone(storyFixture()) as unknown as {
      scenes: Array<Record<string, unknown>>;
    };
    invalid.scenes[0].scrollVh = 180;
    expect(() => validateStoryDocument(invalid)).toThrow(/scrollVh is not supported/);
  });
});
