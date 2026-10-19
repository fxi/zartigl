import { describe, expect, it } from "vitest";
import { parseProjversorView } from "../projversor";
import { parseStoryDocuments, sceneViewId } from "../story";
import {
  homeText,
  parseHome,
  selectLocale,
  selectSlot,
  storyFile,
  type HomeDocument,
} from "./home";
import homeJson from "./public/content/home.json";
import storyJson from "./public/content/stories/2026-11-planet/story.json";
import viewsJson from "./public/content/stories/2026-11-planet/views.json";
import { SITE_LAYOUTS, sceneInset } from "./slots/story";

const home = parseHome(homeJson);
const clone = (): Record<string, unknown> => structuredClone(homeJson);

describe("home.json", () => {
  it("is valid and features a story that exists", () => {
    expect(home.featured).toEqual({ type: "story", id: "2026-11-planet" });
    expect(home.fallback?.type).not.toBe("story");
  });

  it("gives every text in every locale", () => {
    const missing: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record[home.defaultLocale] === "string") {
          for (const locale of home.locales) {
            if (!record[locale]) {
              missing.push(`${path}.${locale}`);
            }
          }
          return;
        }
        for (const [key, v] of Object.entries(record)) {
          walk(v, `${path}.${key}`);
        }
      }
    };
    walk(homeJson, "home");
    expect(missing).toEqual([]);
  });

  it("rejects bad slots, links and missing labels with their path", () => {
    const bad = (mutate: (doc: Record<string, unknown>) => void) => {
      const doc = clone();
      mutate(doc);
      return () => parseHome(doc);
    };
    expect(bad((d) => (d.featured = { type: "map" }))).toThrow(/featured.type/);
    expect(bad((d) => (d.featured = { type: "story", id: "../etc" }))).toThrow(
      /featured.id/,
    );
    expect(bad((d) => (d.fallback = { type: "story", id: "a" }))).toThrow(
      /fallback cannot be a story/,
    );
    expect(
      bad((d) => {
        (d.header as { menu: { href: string }[] }).menu[0].href =
          "javascript:alert(1)";
      }),
    ).toThrow(/header.menu\[0\].href/);
    expect(
      bad((d) => delete (d.labels as Record<string, unknown>).top),
    ).toThrow(/labels.top/);
  });
});

describe("selectSlot", () => {
  it("shows the story with WebGL2 and the fallback without", () => {
    expect(selectSlot(home, true)).toBe(home.featured);
    expect(selectSlot(home, false)).toBe(home.fallback);
    expect(selectSlot(home, true, true)).toBe(home.fallback);
  });

  it("keeps the featured slot when there is no fallback", () => {
    const bare: HomeDocument = { ...home, fallback: undefined };
    expect(selectSlot(bare, false)).toBe(bare.featured);
  });
});

describe("locales and links", () => {
  it("picks the first supported locale, by language base too", () => {
    expect(selectLocale(home, [null, "fr-CH", "en"])).toBe("fr");
    expect(selectLocale(home, ["de"])).toBe("en");
  });

  it("fills {locale} in links and marks other origins external", () => {
    const t = homeText(home, "fr");
    expect(t.href(home.header.menu[0])).toBe(
      "https://unepgrid.ch/fr/our-themes",
    );
    expect(t.text(home.header.brand)).toBe("PNUE/GRID-Genève");
    expect(t.external("https://unepgrid.ch/fr/search")).toBe(false);
    expect(t.external("https://www.youtube.com/user/GRIDGeneva")).toBe(true);
  });

  it("resolves story files under the content root", () => {
    const content = new URL("https://example.org/theme/content/");
    expect(storyFile(content, "2026-11-planet", "story.json").href).toBe(
      "https://example.org/theme/content/stories/2026-11-planet/story.json",
    );
  });
});

describe("story of the month", () => {
  const { story, views } = parseStoryDocuments(storyJson, viewsJson, {
    layouts: SITE_LAYOUTS,
  });

  it("gives every scene a valid projversor view and copy in en and fr", () => {
    const byId = new Map(views.views.map((v) => [v.id, v]));
    for (const scene of story.scenes) {
      const view = byId.get(sceneViewId(scene)!);
      expect(view).toBeDefined();
      expect(() => parseProjversorView(view!)).not.toThrow();
      const copy = scene.blocks.find((b) => b.type === "copy");
      expect(copy?.type).toBe("copy");
      if (copy?.type === "copy") {
        expect(copy.heading.en && copy.heading.fr).toBeTruthy();
        expect(copy.text?.en && copy.text?.fr).toBeTruthy();
      }
    }
  });
});

describe("sceneInset", () => {
  it("frees the side opposite the card on wide screens", () => {
    expect(sceneInset("left", 1400, 900)).toMatchObject({ left: 560 });
    expect(sceneInset("right", 1000, 800)).toMatchObject({ right: 420 });
    expect(sceneInset("intro", 1400, 900)).toMatchObject({ top: 378 });
  });

  it("keeps the sphere above the cards on narrow screens", () => {
    expect(sceneInset("left", 400, 800)).toEqual({
      top: 0,
      right: 0,
      bottom: 240,
      left: 0,
    });
  });
});
