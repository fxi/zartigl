import { renderFooter, renderHeader, renderScrollNav } from "./frame";
import {
  homeText,
  parseHome,
  selectLocale,
  selectSlot,
  storyFile,
  type HomeDocument,
  type HomeSlot,
  type HomeText,
} from "./home";
import { renderArticle, renderVideo } from "./slots/static";
import { mountStory } from "./slots/story";

export interface SiteOptions {
  /** Folder holding `home.json` and `stories/`. */
  contentUrl: URL;
  /** Requested locale; else the page language, else the browser's. */
  locale?: string | null;
  /** Show the fallback slot even when WebGL2 is available. */
  forceFallback?: boolean;
}

export interface Site {
  setLocale(locale: string): Promise<void>;
  destroy(): void;
}

/** WebGL2 support, probed on a throwaway canvas. */
function hasWebgl2(doc: Document): boolean {
  const gl = doc.createElement("canvas").getContext("webgl2");
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return Boolean(gl);
}

/**
 * Mount the home page in `root`: header, the featured slot, footer and
 * scroll buttons, from `home.json`. Self-contained: everything lives under
 * `root`, styles are scoped to `.zs-site`, and no global is set.
 */
export async function mountSite(
  root: HTMLElement,
  options: SiteOptions,
): Promise<Site> {
  const doc = root.ownerDocument;
  const response = await fetch(new URL("home.json", options.contentUrl));
  if (!response.ok) {
    throw new Error(`home.json: HTTP ${response.status}`);
  }
  const home = parseHome(await response.json());
  const webgl = hasWebgl2(doc);
  let teardown: () => void = () => {};

  const render = async (locale: string) => {
    teardown();
    const t = homeText(home, locale);
    root.lang = locale;
    root.classList.add("zs-site");
    const main = doc.createElement("main");
    main.className = "zs-main";
    const header = renderHeader(
      doc,
      home,
      t,
      (next) => void site.setLocale(next),
    );
    const footer = renderFooter(doc, home, t);
    const nav = renderScrollNav(doc, home, t, { top: root, bottom: footer });
    root.replaceChildren(header, main, footer, nav);
    teardown = await mountSlot(
      main,
      home,
      selectSlot(home, webgl, options.forceFallback),
      t,
      options.contentUrl,
    );
  };

  const site: Site = {
    setLocale: (locale) => render(selectLocale(home, [locale])),
    destroy: () => {
      teardown();
      root.replaceChildren();
      root.classList.remove("zs-site");
    },
  };
  const win = doc.defaultView;
  await render(
    selectLocale(home, [
      options.locale,
      doc.documentElement.lang,
      ...(win?.navigator.languages ?? []),
    ]),
  );
  return site;
}

async function mountSlot(
  main: HTMLElement,
  home: HomeDocument,
  slot: HomeSlot,
  t: HomeText,
  contentUrl: URL,
): Promise<() => void> {
  const doc = main.ownerDocument;
  if (slot.type === "story") {
    try {
      return await mountStory(main, {
        folder: storyFile(contentUrl, slot.id, ""),
        t,
        loadingLabel: t.text(home.labels.loading),
        scrollLabel: t.text(home.labels.scroll),
      });
    } catch (error) {
      console.error(error);
      if (!home.fallback) {
        throw error;
      }
      return mountSlot(main, home, home.fallback, t, contentUrl);
    }
  }
  const element =
    slot.type === "video"
      ? renderVideo(doc, slot, t)
      : renderArticle(doc, slot, t);
  main.append(element);
  return () => element.remove();
}
