import {
  PROJECTIONS,
  Projversor,
  ProjversorStoryView,
  legendLabels,
  monthLegend,
  parseProjversorView,
  playheadLabel,
  rampGradient,
  type Inset,
  type ProjversorMonth,
  type ProjversorViewConfig,
} from "../projversor";
import {
  LoadingIndicator,
  StoryRegistry,
  StorySceneTimer,
  defineStoryPager,
  parseStoryDocuments,
  parseStoryHash,
  resolveLocalizedText,
  sceneViewId,
  storyExternalLinkAttributes,
  storyHash,
  type LocalizedText,
  type StoryCopyBlock,
  type StoryDocument,
  type StoryPagerElement,
  type StoryPagerNavigateDetail,
  type StoryScene,
  type StoryViewDefinition,
} from "../story";
import { drawLayoutDebug, type LayoutSnapshot } from "./debug";
import { storyUiLabels, type StoryUiLabels } from "./labels";
import {
  LAYOUT_IDS,
  isLayoutId,
  layoutMetrics,
  limbShape,
  mapInset,
  resolveLayout,
  textZone,
  veilStops,
  type Rect,
} from "./layout";
import storyJson from "./story.json";
import {
  defineTimeline,
  type TimelineElement,
  type TimelineScrubDetail,
} from "./Timeline";
import viewsJson from "./views.json";

/** Scene time when the story gives none. */
const DEFAULT_SCENE_MS = 15000;
/** Easing of the map's free zone after a resize or a text reflow. */
const REFLOW_MS = 300;
/** The view counts as resting after this long without change. */
const REST_MS = 250;

function refs(root: HTMLElement) {
  const get = <T extends Element>(name: string): T => {
    const el = root.querySelector<T>(`[data-ref="${name}"]`);
    if (!el) {
      throw new Error(`Missing element: ${name}`);
    }
    return el;
  };
  return {
    stage: get<HTMLElement>("stage"),
    back: get<HTMLCanvasElement>("back"),
    gl: get<HTMLCanvasElement>("gl"),
    front: get<HTMLCanvasElement>("front"),
    brand: get<HTMLElement>("brand"),
    counter: get<HTMLElement>("counter"),
    edge: get<HTMLElement>("edge"),
    north: get<SVGSVGElement>("north"),
    legend: get<HTMLElement>("legend"),
    legendMax: get<HTMLElement>("legendMax"),
    legendMin: get<HTMLElement>("legendMin"),
    legendRamp: get<HTMLElement>("legendRamp"),
    legendUnit: get<HTMLElement>("legendUnit"),
    zone: get<HTMLElement>("zone"),
    copy: get<HTMLElement>("copy"),
    contour: get<HTMLElement>("contour"),
    kicker: get<HTMLElement>("kicker"),
    headline: get<HTMLElement>("headline"),
    lede: get<HTMLElement>("lede"),
    source: get<HTMLElement>("source"),
    timeline: get<TimelineElement>("timeline"),
    pager: get<StoryPagerElement>("pager"),
    credits: get<HTMLElement>("credits"),
    status: get<HTMLElement>("status"),
    debug: get<HTMLCanvasElement>("debug"),
  };
}

/** `?lang=`, else the first browser language the story is written in. */
function selectLocale(story: StoryDocument, requested: string | null): string {
  const available = new Set(Object.keys(story.title));
  for (const language of [requested ?? "", ...navigator.languages]) {
    if (available.has(language)) {
      return language;
    }
    const base = language.split("-")[0];
    if (available.has(base)) {
      return base;
    }
  }
  return story.defaultLocale;
}

/** "38°N 15°E" for the center of a d3 rotation. */
function centerLabel(rotate: readonly number[]): string {
  const lon = ((((-rotate[0] + 180) % 360) + 360) % 360) - 180;
  const lat = -rotate[1];
  const fmt = (v: number, pos: string, neg: string) =>
    `${Math.abs(Math.round(v))}°${v >= 0 ? pos : neg}`;
  return `${fmt(lat, "N", "S")} ${fmt(lon, "E", "W")}`;
}

function sameInset(a: Inset, b: Inset): boolean {
  return (
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.right - b.right) < 1 &&
    Math.abs(a.bottom - b.bottom) < 1 &&
    Math.abs(a.left - b.left) < 1
  );
}

/**
 * A story on one projversor. Each scene picks a layout: layout.ts resolves
 * it for the viewport, places the text zone, and the measured text sets the
 * veil and the map's free zone. The pager steps through scenes, play/pause
 * drives the scene timer and the data, and the url hash keeps the scene.
 */
export class StoryProjversorApp {
  private readonly ui: ReturnType<typeof refs>;
  private readonly documents = parseStoryDocuments(storyJson, viewsJson, {
    layouts: LAYOUT_IDS,
  });
  private readonly locale: string;
  private readonly labels: StoryUiLabels;
  private readonly projversor: Projversor;
  private readonly adapter: ProjversorStoryView;
  private readonly registry = new StoryRegistry();
  private readonly timer = new StorySceneTimer(() => this.advance());
  private readonly viewById: Map<string, StoryViewDefinition>;
  private readonly loading: LoadingIndicator;
  private readonly params: URLSearchParams;
  /** `?still`: no motion, for screenshots and the contact sheet. */
  private readonly still: boolean;
  private readonly reduced: boolean;
  private index = 0;
  private generation = 0;
  private playing: boolean;
  private config: ProjversorViewConfig | null = null;
  private snapshot: LayoutSnapshot | null = null;
  private layoutFrame = 0;
  private edgeText = "";
  private viewKey = "";
  private viewChanged = 0;
  private wrappedKey = "";

  constructor(private readonly root: HTMLElement) {
    this.ui = refs(root);
    const { story, views } = this.documents;
    const win = root.ownerDocument.defaultView;
    this.params = new URLSearchParams(win?.location.search ?? "");
    this.locale = selectLocale(story, this.params.get("lang"));
    this.labels = storyUiLabels(this.locale);
    this.viewById = new Map(views.views.map((view) => [view.id, view]));
    const { stage, back, gl, front } = this.ui;
    this.projversor = new Projversor({ stage, back, gl, front });
    this.loading = new LoadingIndicator((visible) =>
      root.classList.toggle("is-loading", visible),
    );
    this.still = this.params.has("still");
    this.reduced =
      this.still ||
      Boolean(win?.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.adapter = new ProjversorStoryView(
      this.projversor,
      !this.reduced,
      (error) => this.reportError(error),
    );
    this.registry.registerViewType("projversor", () => this.adapter);
    const shared = parseStoryHash(win?.location.hash ?? "");
    this.playing = !(shared.paused ?? this.reduced);
    const start = story.scenes.findIndex((s) => s.id === shared.scene);
    this.index = Math.max(0, start);
    const doc = root.ownerDocument;
    doc.documentElement.lang = this.locale;
    doc.title = this.text(story.title);
    this.ui.brand.textContent = this.text(story.title);
    this.ui.debug.hidden = !this.params.has("debug");
  }

  start(): void {
    const registry = this.root.ownerDocument.defaultView?.customElements;
    defineStoryPager(registry);
    defineTimeline(registry);
    const { scenes } = this.documents.story;
    const labels = this.labels;
    this.ui.pager.configure(scenes.length, {
      navigation: labels.navigation,
      previous: labels.previous,
      next: labels.next,
      play: labels.play,
      pause: labels.pause,
      step: (i) => labels.step(i, this.text(scenes[i].name)),
    });
    this.ui.pager.playing = this.playing;
    this.projversor.setPlaying(this.playing);
    this.projversor.attachInteraction();
    this.bindEvents();
    void this.activate(this.index);
  }

  private bindEvents(): void {
    const p = this.projversor;
    const { pager, timeline } = this.ui;
    pager.addEventListener("story-pager-navigate", (event) => {
      const { index } = (event as CustomEvent<StoryPagerNavigateDetail>).detail;
      void this.activate(index);
    });
    pager.addEventListener("story-pager-toggle", () =>
      this.setPlaying(!this.playing),
    );
    timeline.addEventListener("timeline-hold", (event) => {
      const held = (event as CustomEvent<boolean>).detail;
      p.setHeld(held);
      if (held) {
        this.timer.pause();
      } else if (this.playing) {
        this.timer.resume();
      }
    });
    timeline.addEventListener("timeline-scrub", (event) => {
      const { time, final } = (event as CustomEvent<TimelineScrubDetail>)
        .detail;
      const times = p.times;
      const inMonth =
        times.length > 1 && time >= times[0] && time <= times[times.length - 1];
      if (inMonth) {
        p.scrub(time);
      } else if (final) {
        p.seek(time).catch((error: unknown) => this.reportError(error));
      }
    });
    p.on("status", (text) => this.setStatus(text));
    p.on("preset", () => this.renderCredits());
    p.on("layer", () => {
      this.renderCredits();
      this.renderTimeline();
    });
    p.on("month", (month) => this.renderLegend(month));
    p.on("palette", (id) =>
      this.ui.legendRamp.style.setProperty("--ramp", rampGradient(id)),
    );
    p.on("frame", () => this.onFrame());
    this.ui.north.setAttribute("aria-label", this.labels.north);
    const doc = this.root.ownerDocument;
    const win = doc.defaultView;
    win?.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const last = this.documents.story.scenes.length - 1;
      const target: Record<string, number> = {
        ArrowRight: this.index + 1,
        PageDown: this.index + 1,
        ArrowLeft: this.index - 1,
        PageUp: this.index - 1,
        Home: 0,
        End: last,
      };
      if (event.key in target) {
        event.preventDefault();
        const index = Math.max(0, Math.min(last, target[event.key]));
        if (index !== this.index) {
          void this.activate(index);
        }
      } else if (event.key === " " && event.target === doc.body) {
        event.preventDefault();
        this.setPlaying(!this.playing);
      }
    });
    doc.addEventListener("visibilitychange", () => {
      if (doc.hidden) {
        this.timer.pause();
        p.setPlaying(false);
      } else if (this.playing) {
        this.timer.resume();
        p.setPlaying(true);
      }
    });
    // Resizes and text reflows move the free zone, never the scene.
    const observer = new ResizeObserver(() => this.scheduleLayout());
    observer.observe(this.root);
    observer.observe(this.ui.copy);
  }

  /** Show scene `index`; its timer starts once its data is on screen. */
  private async activate(index: number): Promise<void> {
    const { scenes } = this.documents.story;
    const scene = scenes[index];
    const generation = ++this.generation;
    this.index = index;
    this.timer.stop();
    this.ui.pager.index = index;
    const viewId = sceneViewId(scene);
    const view = viewId ? this.viewById.get(viewId) : undefined;
    this.config = view ? parseProjversorView(view) : null;
    this.renderScene(scene);
    this.layout(this.config?.transitionMs ?? 0);
    this.reveal();
    history.replaceState(
      null,
      "",
      `${location.search}#${storyHash(scene.id, !this.playing)}`,
    );
    if (!view) {
      this.setStatus(`Missing view for scene ${scene.id}`);
      return;
    }
    this.loading.show();
    try {
      await this.registry.getViewAdapter(view.type).activate(view, scene);
    } catch (error) {
      if (generation === this.generation) {
        this.reportError(error);
      }
      return;
    } finally {
      if (generation === this.generation) {
        this.loading.hide();
      }
    }
    if (generation !== this.generation) {
      return;
    }
    if (!this.still) {
      this.timer.start(scene.durationMs ?? DEFAULT_SCENE_MS, !this.playing);
    }
    this.preload(scenes[(index + 1) % scenes.length]);
  }

  /** Next scene when the timer runs out; the story loops. */
  private advance(): void {
    const count = this.documents.story.scenes.length;
    void this.activate((this.index + 1) % count);
  }

  private preload(scene: StoryScene): void {
    const viewId = sceneViewId(scene);
    const view = viewId ? this.viewById.get(viewId) : undefined;
    if (view) {
      this.adapter.preload(view).catch((error: unknown) => {
        console.error(error);
      });
    }
  }

  private setPlaying(playing: boolean): void {
    this.playing = playing;
    this.ui.pager.playing = playing;
    this.projversor.setPlaying(playing);
    if (playing) {
      this.timer.resume();
    } else {
      this.timer.pause();
    }
    const scene = this.documents.story.scenes[this.index];
    history.replaceState(
      null,
      "",
      `${location.search}#${storyHash(scene.id, !playing)}`,
    );
  }

  // ---- layout -------------------------------------------------------------

  private scheduleLayout(): void {
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => this.layout(REFLOW_MS));
  }

  /**
   * Resolve the scene layout for the viewport, place the text zone, then
   * measure the text: it sets the veil stops and the map's free zone, eased
   * over `durationMs`.
   */
  private layout(durationMs: number): void {
    const scene = this.documents.story.scenes[this.index];
    const { root, ui } = this;
    const viewport = { width: root.clientWidth, height: root.clientHeight };
    if (!viewport.width || !viewport.height || !isLayoutId(scene.layout)) {
      return;
    }
    const metrics = layoutMetrics(viewport);
    const resolved = resolveLayout(scene.layout, viewport);
    const { variant } = resolved;
    const zone = textZone(variant, viewport, metrics);
    const style = root.style;
    style.setProperty("--gutter", `${metrics.gutter}px`);
    style.setProperty("--masthead", `${metrics.masthead}px`);
    style.setProperty("--dock", `${metrics.dock}px`);
    style.setProperty("--zone-x", `${zone.x}px`);
    style.setProperty("--zone-y", `${zone.y}px`);
    style.setProperty("--zone-w", `${zone.width}px`);
    style.setProperty("--zone-h", `${zone.height}px`);
    root.dataset.layout = scene.layout;
    root.dataset.variant = variant;
    root.dataset.align = resolved.align;
    root.dataset.edge = resolved.edge;
    this.fit(zone, variant);
    const wraps = this.wraps(variant);
    if (!wraps) {
      ui.contour.style.removeProperty("shape-outside");
      this.wrappedKey = "";
    }
    // A wrapped paragraph follows the globe, so the zone, not the text,
    // bounds the map: the free zone must not chase its own reflow.
    const text = wraps ? zone : this.copyRect(variant);
    const inset = mapInset(variant, viewport, text, metrics);
    if (!sameInset(inset, this.projversor.inset)) {
      this.projversor.setInset(inset, this.reduced ? 0 : durationMs);
    }
    if (resolved.angle === null) {
      style.setProperty("--veil-opacity", "0");
    } else {
      const stops = veilStops(resolved.angle, viewport, text);
      style.setProperty("--veil-opacity", "1");
      style.setProperty("--veil-angle", `${resolved.angle}deg`);
      style.setProperty("--veil-solid", `${stops.solid}%`);
      style.setProperty("--veil-clear", `${stops.clear}%`);
    }
    this.snapshot = {
      scene: scene.id,
      layout: scene.layout,
      variant,
      viewport,
      zone,
      text: this.copyRect(variant),
      inset,
      outline: [],
    };
  }

  /**
   * Shrink the headline until the text fits its zone (height, and width for
   * long words), down to 60%; then compact the text. Measures synchronously,
   * only on layout changes.
   */
  private fit(zone: Rect, variant: string): void {
    const { root, ui } = this;
    root.style.setProperty("--fit", "1");
    root.classList.remove("is-compact");
    if (variant === "none") {
      return;
    }
    const fits = () =>
      ui.copy.getBoundingClientRect().height <= zone.height + 1 &&
      ui.headline.scrollWidth <= ui.headline.clientWidth + 1;
    let scale = 1;
    while (!fits() && scale > 0.6) {
      scale = Math.round(scale * 0.9 * 100) / 100;
      root.style.setProperty("--fit", String(scale));
    }
    if (!fits()) {
      root.classList.add("is-compact");
    }
  }

  private wraps(variant: string): boolean {
    return (
      Boolean(this.config?.wrap) && (variant === "w-e" || variant === "e-w")
    );
  }

  /** The text's box in page px; empty when the layout has none. */
  private copyRect(variant: string): Rect {
    if (variant === "none") {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const page = this.root.getBoundingClientRect();
    const box = this.ui.copy.getBoundingClientRect();
    return {
      x: box.left - page.left,
      y: box.top - page.top,
      width: box.width,
      height: box.height,
    };
  }

  /** Text follows the globe limb once the view rests. */
  private updateWrap(): void {
    const snapshot = this.snapshot;
    if (!snapshot || !this.wraps(snapshot.variant)) {
      return;
    }
    // The copy is a flex item, so it contains its floats: the float spans
    // the text lines only, or the copy would grow to the float.
    const copy = this.copyRect(snapshot.variant);
    const height = this.textHeight();
    const box = { ...copy, height };
    const side = this.root.dataset.edge === "left" ? "left" : "right";
    const shape = limbShape(this.projversor.outline(), box, side);
    const { contour } = this.ui;
    if (shape) {
      contour.style.height = `${height}px`;
      contour.style.setProperty("shape-outside", shape);
    } else {
      contour.style.removeProperty("shape-outside");
    }
  }

  /** Height of the text lines, without the contour float. */
  private textHeight(): number {
    const { copy, kicker, headline, lede, source } = this.ui;
    const top = copy.getBoundingClientRect().top;
    const bottoms = [kicker, headline, lede, source]
      .filter((el) => !el.hidden)
      .map((el) => el.getBoundingClientRect().bottom);
    return Math.max(0, ...bottoms) - top;
  }

  // ---- per frame ----------------------------------------------------------

  private onFrame(): void {
    const p = this.projversor;
    this.ui.pager.progress = this.timer.progress;
    const key = JSON.stringify([p.rotate, p.zoom, p.inset, p.preset.id]);
    const now = performance.now();
    if (key !== this.viewKey) {
      this.viewKey = key;
      this.viewChanged = now;
      this.renderEdge();
    } else if (now - this.viewChanged > REST_MS && key !== this.wrappedKey) {
      this.wrappedKey = key;
      this.updateWrap();
      if (this.snapshot && !this.ui.debug.hidden) {
        this.snapshot.outline = p.outline();
        this.snapshot.text = this.copyRect(this.snapshot.variant);
        drawLayoutDebug(this.ui.debug, this.snapshot);
      }
    }
    this.renderTime();
  }

  /** Color scale of the shown month: min, palette and max. */
  private renderLegend(month: ProjversorMonth): void {
    const { legend, legendMax, legendMin, legendUnit } = this.ui;
    const scale = monthLegend(month);
    const [min, max] = legendLabels(scale.min, scale.max, this.locale);
    legendMin.textContent = min;
    legendMax.textContent = max;
    legendUnit.textContent = scale.unit;
    legend.setAttribute("aria-label", this.labels.legend(min, max, scale.unit));
    legend.hidden = false;
  }

  private renderEdge(): void {
    const p = this.projversor;
    const north = p.northAngle();
    this.ui.north.classList.toggle("is-pole", north === null);
    if (north !== null) {
      this.ui.north.style.setProperty("--north", `${north.toFixed(1)}deg`);
    }
    const projection = PROJECTIONS[p.preset.projection].label;
    const text = `${centerLabel(p.rotate)}  ·  ${projection}`;
    if (text !== this.edgeText) {
      this.edgeText = text;
      this.ui.edge.textContent = text;
    }
  }

  private renderTime(): void {
    const p = this.projversor;
    const times = p.times;
    if (times.length < 2 || this.ui.timeline.hidden) {
      return;
    }
    const stepMs = (times[times.length - 1] - times[0]) / (times.length - 1);
    const { date, hour } = playheadLabel(p.time, stepMs);
    this.ui.timeline.setTime(
      p.time,
      p.chunkIndex,
      hour ? `${date} ${hour}` : date,
    );
  }

  private renderTimeline(): void {
    const spans = this.projversor.chunks
      .map((chunk) => ({
        start: Date.parse(chunk.temporal?.start ?? ""),
        end: Date.parse(chunk.temporal?.end ?? ""),
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
    this.ui.timeline.setSpans(spans, this.locale, this.labels.timeline);
  }

  // ---- scene --------------------------------------------------------------

  private renderScene(scene: StoryScene): void {
    const { story } = this.documents;
    const theme = story.themes[scene.theme];
    const style = this.root.style;
    style.setProperty("--story-bg", theme.background);
    style.setProperty("--story-fg", theme.foreground);
    style.setProperty("--story-muted", theme.muted);
    style.setProperty("--accent", theme.accent);
    this.root.dataset.scene = scene.id;
    const copy = scene.blocks.find(
      (block): block is StoryCopyBlock => block.type === "copy",
    );
    const { ui } = this;
    ui.kicker.textContent = copy?.label ? this.text(copy.label) : "";
    ui.kicker.hidden = !copy?.label;
    this.renderHeadline(copy ? this.text(copy.heading) : "");
    ui.lede.textContent = copy?.text ? this.text(copy.text) : "";
    ui.lede.hidden = !copy?.text;
    this.renderSource(copy);
    ui.timeline.hidden = !copy?.showTime;
    this.renderCounter();
  }

  /** One masked span per word, for the reveal. */
  private renderHeadline(text: string): void {
    const doc = this.root.ownerDocument;
    const words = text.split(/\s+/).filter(Boolean);
    const nodes: Node[] = [];
    words.forEach((word, i) => {
      if (i > 0) {
        nodes.push(doc.createTextNode(" "));
      }
      const mask = doc.createElement("span");
      mask.className = "w";
      const inner = doc.createElement("span");
      inner.textContent = word;
      mask.append(inner);
      nodes.push(mask);
    });
    this.ui.headline.replaceChildren(...nodes);
    this.ui.headline.setAttribute("aria-label", text);
  }

  /** Words rise through their masks, then the text fades in. */
  private reveal(): void {
    if (this.reduced) {
      return;
    }
    const { ui } = this;
    const ease = "cubic-bezier(.16,1,.3,1)";
    ui.headline.querySelectorAll<HTMLElement>(".w > span").forEach((el, i) => {
      el.animate(
        [{ transform: "translateY(105%)" }, { transform: "translateY(0)" }],
        { duration: 900, delay: 120 + i * 55, easing: ease, fill: "backwards" },
      );
    });
    for (const [el, delay] of [
      [ui.kicker, 0],
      [ui.lede, 380],
      [ui.source, 520],
    ] as const) {
      el.animate(
        [
          { opacity: 0, transform: "translateY(10px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 700, delay, easing: ease, fill: "backwards" },
      );
    }
  }

  private renderSource(copy: StoryCopyBlock | undefined): void {
    const { source } = this.ui;
    const doc = this.root.ownerDocument;
    const items = copy?.references ?? [];
    source.hidden = items.length === 0;
    source.replaceChildren();
    items.forEach((reference, i) => {
      if (i > 0) {
        source.append(doc.createTextNode(" · "));
      }
      const link = doc.createElement("a");
      Object.assign(
        link,
        storyExternalLinkAttributes(reference, this.text(reference.label)),
      );
      source.append(link);
    });
  }

  private renderCounter(): void {
    const doc = this.root.ownerDocument;
    const count = this.documents.story.scenes.length;
    const pad = (n: number) => String(n).padStart(2, "0");
    const current = doc.createElement("b");
    current.textContent = pad(this.index + 1);
    this.ui.counter.replaceChildren(current, ` / ${pad(count)}`);
  }

  private renderCredits(): void {
    const p = this.projversor;
    const provider = p.chunks[0]?.provenance?.provider;
    const data =
      provider === "copernicus-marine" ? "Copernicus Marine" : provider;
    this.ui.credits.textContent = [
      data,
      `${this.labels.render} zartigl projversor`,
    ]
      .filter(Boolean)
      .join("  ·  ");
  }

  /** A failed month load: log it and say so in the status line. */
  private reportError(error: unknown): void {
    console.error(error);
    this.setStatus(error instanceof Error ? error.message : String(error));
  }

  private setStatus(text: string): void {
    if (this.ui.status.textContent !== text) {
      this.ui.status.textContent = text;
    }
  }

  private text(value: LocalizedText): string {
    const { story } = this.documents;
    return resolveLocalizedText(
      value,
      this.locale,
      story.defaultLocale,
      story.fallbackLocales,
    );
  }
}
