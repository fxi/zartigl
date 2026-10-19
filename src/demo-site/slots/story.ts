import {
  Projversor,
  ProjversorStoryView,
  parseProjversorView,
  type Inset,
} from "../../projversor";
import {
  LoadingIndicator,
  StoryScroller,
  parseStoryDocuments,
  sceneViewId,
  storyExternalLinkAttributes,
  type StoryCopyBlock,
  type StoryDocument,
  type StoryScene,
  type StoryViewDefinition,
} from "../../story";
import type { HomeText } from "../home";

/** Scene layouts of a scroll story: the side the text takes beside the sphere. */
export const SITE_LAYOUTS = ["intro", "left", "right"] as const;
export type SiteLayout = (typeof SITE_LAYOUTS)[number];

/** Below this width, the text runs under the sphere instead of beside it. */
const WIDE_MIN = 900;
/** Activation line, from the top of the viewport. */
const LINE = 0.6;
const EASE = "cubic-bezier(.16,1,.3,1)";

/**
 * Free zone of the sphere for a scene layout, css px: beside the text on
 * wide screens, above it on narrow ones.
 */
export function sceneInset(
  layout: string,
  width: number,
  height: number,
): Inset {
  if (width < WIDE_MIN) {
    return { top: 0, right: 0, bottom: Math.round(height * 0.3), left: 0 };
  }
  const side = Math.round(Math.min(width * 0.42, 560));
  if (layout === "left") {
    return { top: 0, right: 0, bottom: 0, left: side };
  }
  if (layout === "right") {
    return { top: 0, right: side, bottom: 0, left: 0 };
  }
  return { top: Math.round(height * 0.42), right: 0, bottom: 0, left: 0 };
}

async function fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${url.pathname}: HTTP ${response.status}`);
  }
  return response.json();
}

/** Load and validate a story folder: `story.json` and `views.json`. */
export async function loadStory(
  folder: URL,
  signal: AbortSignal,
): Promise<ReturnType<typeof parseStoryDocuments>> {
  const [story, views] = await Promise.all([
    fetchJson(new URL("story.json", folder), signal),
    fetchJson(new URL("views.json", folder), signal),
  ]);
  return parseStoryDocuments(story, views, { layouts: SITE_LAYOUTS });
}

function sceneCopy(scene: StoryScene): StoryCopyBlock | undefined {
  return scene.blocks.find(
    (block): block is StoryCopyBlock => block.type === "copy",
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A headline with one masked span per word, for the reveal. */
function headline(doc: Document, tag: "h1" | "h2", text: string): HTMLElement {
  const el = doc.createElement(tag);
  el.className = "zs-headline";
  el.setAttribute("aria-label", text);
  text
    .split(/\s+/)
    .filter(Boolean)
    .forEach((word, i) => {
      if (i > 0) {
        el.append(" ");
      }
      const mask = doc.createElement("span");
      mask.className = "zs-w";
      mask.setAttribute("aria-hidden", "true");
      const inner = doc.createElement("span");
      inner.textContent = word;
      mask.append(inner);
      el.append(mask);
    });
  return el;
}

function renderStep(
  doc: Document,
  story: StoryDocument,
  scene: StoryScene,
  index: number,
  t: HomeText,
): HTMLElement {
  const step = doc.createElement("article");
  step.className = "zs-step";
  step.dataset.layout = scene.layout;
  step.dataset.scene = scene.id;
  const text = doc.createElement("div");
  text.className = "zs-text";
  const copy = sceneCopy(scene);

  // The opening step is a prelude: no kicker, numbering starts after it.
  if (index > 0) {
    const kicker = doc.createElement("p");
    kicker.className = "zs-kicker";
    const number = doc.createElement("span");
    number.className = "zs-index";
    number.textContent = pad(index);
    const rule = doc.createElement("span");
    rule.className = "zs-rule";
    kicker.append(number, rule);
    if (copy?.label) {
      kicker.append(t.text(copy.label));
    }
    text.append(kicker);
  }
  text.append(
    headline(
      doc,
      index === 0 ? "h1" : "h2",
      copy ? t.text(copy.heading) : t.text(scene.name),
    ),
  );
  if (copy?.text) {
    const lede = doc.createElement("p");
    lede.className = "zs-lede";
    lede.textContent = t.text(copy.text);
    text.append(lede);
  }
  const references = copy?.references ?? [];
  if (references.length) {
    const source = doc.createElement("p");
    source.className = "zs-source";
    references.forEach((reference, i) => {
      if (i > 0) {
        source.append(" · ");
      }
      const a = doc.createElement("a");
      Object.assign(
        a,
        storyExternalLinkAttributes(reference, t.text(reference.label)),
      );
      source.append(a);
    });
    text.append(source);
  }
  const theme = story.themes[scene.theme];
  if (theme) {
    step.style.setProperty("--zs-accent", theme.accent);
  }
  step.append(text);
  return step;
}

/** Words rise through their masks, then the rest fades in. */
function reveal(step: HTMLElement): void {
  step.querySelectorAll<HTMLElement>(".zs-w > span").forEach((el, i) => {
    el.animate(
      [{ transform: "translateY(105%)" }, { transform: "translateY(0)" }],
      { duration: 900, delay: 120 + i * 55, easing: EASE, fill: "backwards" },
    );
  });
  const parts: [string, number][] = [
    [".zs-kicker", 0],
    [".zs-lede", 380],
    [".zs-source", 520],
  ];
  for (const [selector, delay] of parts) {
    step.querySelector(selector)?.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 700, delay, easing: EASE, fill: "backwards" },
    );
  }
  step
    .querySelector(".zs-rule")
    ?.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
      duration: 900,
      easing: EASE,
      fill: "backwards",
    });
}

/** Chapter rail: the scene names, each a jump to its step. */
function renderRail(
  doc: Document,
  story: StoryDocument,
  steps: readonly HTMLElement[],
  t: HomeText,
  behavior: ScrollBehavior,
): { rail: HTMLElement; items: HTMLElement[] } {
  const rail = doc.createElement("nav");
  rail.className = "zs-rail";
  rail.setAttribute("aria-label", t.text(story.title));
  const list = doc.createElement("ol");
  const items = story.scenes.map((scene, i) => {
    const li = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    const n = doc.createElement("span");
    n.className = "zs-rail-n";
    n.textContent = i > 0 ? pad(i) : "";
    const name = doc.createElement("span");
    name.className = "zs-rail-name";
    name.textContent = t.text(scene.name);
    button.append(n, name);
    button.addEventListener("click", () =>
      steps[i].scrollIntoView({ behavior, block: "center" }),
    );
    li.append(button);
    list.append(li);
    return li;
  });
  rail.append(list);
  return { rail, items };
}

export interface StorySlotOptions {
  folder: URL;
  t: HomeText;
  loadingLabel: string;
  scrollLabel: string;
}

/**
 * A scroll story: one sticky projversor sphere behind the text, a veil on
 * the text side and a chapter rail. The step crossing the activation line
 * drives the view and replays its reveal; the sphere pauses when the story
 * is off screen or the tab hidden. Throws when WebGL2 is missing, before
 * anything is attached.
 */
export async function mountStory(
  host: HTMLElement,
  options: StorySlotOptions,
): Promise<() => void> {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const abort = new AbortController();
  const { story, views } = await loadStory(options.folder, abort.signal);
  const viewById = new Map(views.views.map((view) => [view.id, view]));
  const viewOf = (scene: StoryScene): StoryViewDefinition | undefined => {
    const id = sceneViewId(scene);
    return id ? viewById.get(id) : undefined;
  };
  const reduced = Boolean(
    win?.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const root = doc.createElement("section");
  root.className = "zs-story";
  root.setAttribute("aria-label", options.t.text(story.title));
  const stage = doc.createElement("div");
  stage.className = "zs-stage";
  const [back, gl, front] = ["back", "gl", "front"].map(() =>
    doc.createElement("canvas"),
  );
  const veil = doc.createElement("div");
  veil.className = "zs-veil";
  const status = doc.createElement("p");
  status.className = "zs-status";
  status.setAttribute("role", "status");
  const steps = doc.createElement("div");
  steps.className = "zs-steps";
  const stepEls = story.scenes.map((scene, i) =>
    renderStep(doc, story, scene, i, options.t),
  );
  // Scroll invitation on the first step: a label over a falling line.
  const cue = doc.createElement("p");
  cue.className = "zs-cue";
  cue.textContent = options.scrollLabel;
  const line = doc.createElement("span");
  line.className = "zs-cue-line";
  line.setAttribute("aria-hidden", "true");
  cue.append(line);
  stepEls[0].append(cue);
  steps.append(...stepEls);
  const { rail, items } = renderRail(
    doc,
    story,
    stepEls,
    options.t,
    reduced ? "auto" : "smooth",
  );
  stage.append(back, gl, front, veil, rail, status);
  root.append(stage, steps);

  // Attached first: the overlay reads its colors from the computed style.
  // Throws without WebGL2: the caller then shows the fallback slot.
  host.append(root);
  let projversor: Projversor;
  try {
    projversor = new Projversor({ stage, back, gl, front });
  } catch (error) {
    root.remove();
    throw error;
  }
  const adapter = new ProjversorStoryView(projversor, !reduced, (error) =>
    report(error),
  );
  const loading = new LoadingIndicator((visible) => {
    root.classList.toggle("is-loading", visible);
    if (visible) {
      status.textContent = options.loadingLabel;
    } else if (status.textContent === options.loadingLabel) {
      status.textContent = "";
    }
  });
  const report = (error: unknown) => {
    console.error(error);
    loading.hide(true);
    status.textContent = error instanceof Error ? error.message : String(error);
  };

  let active = -1;
  let generation = 0;
  const inset = (durationMs: number) => {
    const scene = story.scenes[Math.max(0, active)];
    const { width, height } = stage.getBoundingClientRect();
    projversor.setInset(sceneInset(scene.layout, width, height), durationMs);
  };

  const activate = async (index: number) => {
    if (index === active) {
      return;
    }
    const scene = story.scenes[index];
    const view = viewOf(scene);
    const current = ++generation;
    active = index;
    root.dataset.layout = scene.layout;
    const accent = story.themes[scene.theme]?.accent;
    if (accent) {
      root.style.setProperty("--zs-accent", accent);
    }
    stepEls.forEach((el, i) => el.classList.toggle("is-active", i === index));
    items.forEach((el, i) => el.classList.toggle("is-active", i === index));
    if (!reduced) {
      reveal(stepEls[index]);
    }
    if (!view) {
      report(new Error(`Missing view for scene ${scene.id}`));
      return;
    }
    const { transitionMs } = parseProjversorView(view);
    inset(reduced ? 0 : (transitionMs ?? 0));
    loading.show();
    try {
      await adapter.activate(view);
      if (current !== generation) {
        return;
      }
      loading.hide();
      const next = story.scenes[index + 1];
      const nextView = next && viewOf(next);
      if (nextView) {
        adapter.preload(nextView).catch(() => {});
      }
    } catch (error) {
      if (current === generation) {
        report(error);
      }
    }
  };

  // Play only while the story is on screen and the tab visible.
  let onScreen = false;
  const syncPlaying = () =>
    projversor.setPlaying(onScreen && !doc.hidden && !reduced);
  const visibility = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    syncPlaying();
  });
  visibility.observe(root);
  doc.addEventListener("visibilitychange", syncPlaying);
  const resize = new ResizeObserver(() => inset(0));
  resize.observe(stage);

  syncPlaying();
  const scroller = new StoryScroller(stepEls, (index) => void activate(index), {
    line: LINE,
  });
  // Above the first step, show the first scene.
  if (scroller.active < 0) {
    void activate(0);
  }

  return () => {
    abort.abort();
    scroller.destroy();
    visibility.disconnect();
    resize.disconnect();
    doc.removeEventListener("visibilitychange", syncPlaying);
    adapter.destroy();
    root.remove();
  };
}
