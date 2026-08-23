import maplibregl from "maplibre-gl";
import { catalog } from "../catalog";
import { Zartigl } from "../lib";
import storyJson from "./story.json";
import viewsJson from "./views.json";
import { ZartiglStoryView } from "./adapters/ZartiglStoryView";
import {
  advanceStorySequence, initializeAfterStaticRender, nextStoryIndex, parseStoryDocuments,
  resolveLocalizedText, sceneViewId, StoryRegistry, StoryTimePresentation, StoryWidgetLifecycle,
  type StoryCopyBlock, type StoryScene, type StoryViewAdapter, type StoryWidgetRun,
} from "./runtime";
import { registerStoryWidgets } from "./widgets/storyWidgets";

const documents = parseStoryDocuments(storyJson, viewsJson);

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing story element: ${selector}`);
  return element;
}

function formatTime(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "UTC", timeZoneName: "short",
  }).format(new Date(ms));
}

function mapStyle(): string {
  const token = import.meta.env.MAPTILER_TOKEN;
  return token ? `https://api.maptiler.com/maps/satellite-v4/style.json?key=${token}` : "https://demotiles.maplibre.org/style.json";
}

function selectLocale(): string {
  const available = new Set(Object.keys(documents.story.title));
  for (const language of navigator.languages) {
    if (available.has(language)) return language;
    const base = language.split("-")[0];
    if (available.has(base)) return base;
  }
  return documents.story.defaultLocale;
}

export class StoryApp {
  private readonly story = required<HTMLElement>("#story");
  private readonly signal = required<HTMLElement>("#signal");
  private readonly title = required<HTMLElement>("#title");
  private readonly description = required<HTMLElement>("#description");
  private readonly copy = required<HTMLElement>("#copy");
  private readonly timestamp = required<HTMLElement>("#timestamp");
  private readonly analysis = required<HTMLElement>("#analysis");
  private readonly status = required<HTMLElement>("#status");
  private readonly counter = required<HTMLElement>("#counter");
  private readonly progress = required<HTMLElement>("#progress");
  private readonly previous = required<HTMLButtonElement>("#previous");
  private readonly next = required<HTMLButtonElement>("#next");
  private readonly playButton = required<HTMLButtonElement>("#play");
  private readonly verticalMark = required<HTMLElement>("#vertical-mark");
  private readonly extras = required<HTMLElement>("#story-extras");
  private readonly registry = new StoryRegistry();
  private readonly widgetLifecycle = new StoryWidgetLifecycle();
  private readonly timePresentation = new StoryTimePresentation();
  private readonly locale = selectLocale();
  private readonly viewById = new Map(documents.views.views.map((view) => [view.id, view]));

  private activeAdapter: StoryViewAdapter | null = null;
  private activeViewId: string | undefined;
  private index = 0;
  private generation = 0;
  private chartCursor: (time: number) => void = () => undefined;
  private sequenceTimer: number | null = null;
  private sequenceIndex = 0;
  private sequenceDirection: 1 | -1 = 1;
  private sequenceSceneIndex = -1;
  private playing = true;
  private wheelLockedUntil = 0;
  private ready = false;

  async start(): Promise<void> {
    this.bindEvents();
    const initialScene = documents.story.scenes[0];
    const initialView = this.viewById.get(sceneViewId(initialScene)!);
    const initialCamera = initialView?.config.camera as { center: [number, number]; zoom: number };
    const map = await initializeAfterStaticRender(() => {
      this.verticalMark.textContent = this.text(documents.story.chrome?.verticalMark ?? { en: "" });
      this.renderStatic(initialScene);
    }, async () => {
      const nextMap = new maplibregl.Map({ container: "map", style: mapStyle(), center: initialCamera.center, zoom: initialCamera.zoom, maxZoom: 9, attributionControl: false });
      nextMap.scrollZoom.disable();
      nextMap.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
      await new Promise<void>((resolve, reject) => {
        nextMap.once("load", resolve);
        nextMap.once("error", (event) => reject(event.error ?? new Error("Map failed to load")));
      }).catch((error: unknown) => {
        this.setStatus(error instanceof Error ? error.message : "Map failed to load", true);
        throw error;
      });
      return nextMap;
    });
    map.setProjection({ type: "globe" });

    const zartigl = new Zartigl({
      id: "zartigl-story", map, catalog, backend: "geovideo",
      geoVideo: { autoplay: true, loop: true, playbackRate: 1 }, visible: false, before: "enso-region-fill",
    });
    this.registry.registerViewType("zartigl-map", () => new ZartiglStoryView(map, zartigl, {
      status: (message, error) => this.setStatus(message, error),
      time: (time) => this.setActiveTime(time),
    }));
    registerStoryWidgets(this.registry);
    this.ready = true;
    this.renderControls(initialScene);
    this.setStatus("");
    await this.activate(0, false);
  }

  private bindEvents(): void {
    this.previous.addEventListener("click", () => void this.go(-1));
    this.next.addEventListener("click", () => void this.go(1));
    this.playButton.addEventListener("click", () => this.togglePlayback());
    window.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        void this.go(1);
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void this.go(-1);
      }
    });
    this.story.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) < 12 || Date.now() < this.wheelLockedUntil) return;
      event.preventDefault();
      this.wheelLockedUntil = Date.now() + 800;
      void this.go(event.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pausePlayback();
      else if (this.playing) this.resumePlayback();
    });
  }

  private async go(delta: number): Promise<void> {
    if (!this.ready) return;
    const target = nextStoryIndex(this.index, delta, documents.story.scenes.length);
    if (target !== this.index) await this.activate(target);
  }

  private async activate(index: number, render = true): Promise<void> {
    const scene = documents.story.scenes[index];
    const generation = ++this.generation;
    const widgetRun = this.widgetLifecycle.begin();
    this.index = index;
    this.sequenceSceneIndex = -1;
    this.timePresentation.setScene(scene);
    this.pausePlayback();
    this.chartCursor = () => undefined;
    if (render) this.renderStatic(scene);
    const viewId = sceneViewId(scene);
    const view = viewId ? this.viewById.get(viewId) : undefined;
    if (!view) {
      this.setStatus(`Missing view for scene ${scene.id}`, true);
      return;
    }
    try {
      const adapter = this.registry.getViewAdapter(view.type);
      this.activeAdapter = adapter;
      this.activeViewId = view.id;
      await adapter.activate(view, scene);
      if (generation !== this.generation) return;
      this.prepareSequenceStart(scene);
      await this.renderWidget(scene, generation, widgetRun);
      if (generation !== this.generation) return;
      const current = adapter instanceof ZartiglStoryView ? adapter.zartigl.getTimeMeta().current : undefined;
      if (current !== undefined) this.setActiveTime(current);
      if (this.playing) this.resumePlayback();
    } catch (error) {
      if (generation !== this.generation) return;
      this.setStatus(error instanceof Error ? error.message : "Unable to activate this scene", true);
    }
  }

  private async renderWidget(scene: StoryScene, generation: number, run: StoryWidgetRun): Promise<void> {
    const block = scene.blocks.find((entry) => entry.type === "widget");
    if (!block || generation !== this.generation) return;
    const host = document.createElement("div");
    host.className = "widget-host";
    this.analysis.replaceChildren(host);
    const cleanup = await this.registry.getWidget(block.widget)(host, block.config ?? {}, {
      scene, locale: this.locale, signal: run.signal,
      getViewAdapter: (viewId) => viewId === this.activeViewId ? this.activeAdapter ?? undefined : undefined,
      setTimeCursor: (cursor) => void run.runIfCurrent(() => {
        if (generation === this.generation) this.chartCursor = cursor;
      }),
    });
    run.settle(cleanup);
  }

  private renderStatic(scene: StoryScene): void {
    const theme = documents.story.themes[scene.theme];
    const copy = scene.blocks.find((block): block is StoryCopyBlock => block.type === "copy");
    this.timePresentation.setScene(scene);
    this.story.dataset.scene = scene.id;
    this.story.dataset.layout = scene.layout;
    this.story.dataset.copyBackdrop = copy?.backdrop ?? "none";
    this.story.style.setProperty("--story-bg", theme.background);
    this.story.style.setProperty("--story-fg", theme.foreground);
    this.story.style.setProperty("--story-muted", theme.muted);
    this.story.style.setProperty("--accent", theme.accent);
    this.story.style.setProperty("--accent-soft", theme.accentSoft);
    this.story.style.setProperty("--story-surface", theme.surface);
    this.story.dataset.glowAnchor = theme.glowAnchor ?? "center";
    this.signal.textContent = copy?.label ? this.text(copy.label) : "";
    this.signal.hidden = !copy?.label;
    this.title.textContent = copy ? this.text(copy.heading) : "";
    this.description.textContent = copy?.text ? this.text(copy.text) : "";
    this.copy.dataset.orientation = copy?.orientation ?? "horizontal";
    this.timestamp.textContent = "";
    this.timestamp.hidden = !this.timePresentation.visible;
    this.counter.textContent = `${String(this.index + 1).padStart(2, "0")} / ${String(documents.story.scenes.length).padStart(2, "0")}`;
    this.progress.style.width = `${((this.index + 1) / documents.story.scenes.length) * 100}%`;
    this.renderControls(scene);
    this.analysis.hidden = !scene.blocks.some((block) => block.type === "widget");
    this.analysis.replaceChildren();
    this.renderExtraBlocks(scene);
    this.title.parentElement?.animate(
      [{ opacity: 0, transform: "translateX(-5vw)", filter: "blur(12px)" }, { opacity: 1, transform: "none", filter: "none" }],
      { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 800, easing: "cubic-bezier(.16,1,.3,1)" },
    );
  }

  private renderControls(scene: StoryScene): void {
    this.previous.disabled = !this.ready || this.index === 0;
    this.next.disabled = !this.ready || this.index === documents.story.scenes.length - 1;
    const canPlay = scene.playback !== undefined && scene.playback.mode !== "none";
    this.playButton.hidden = !this.ready || !canPlay;
    this.playButton.textContent = this.playing ? "Pause" : "Play";
  }

  private renderExtraBlocks(scene: StoryScene): void {
    this.extras.replaceChildren();
    for (const block of scene.blocks) {
      if (block.type !== "text" && block.type !== "credit" && block.type !== "label") continue;
      const element = document.createElement(block.type === "label" ? "span" : "p");
      element.className = `story-block story-block-${block.type}`;
      element.dataset.slot = block.slot;
      element.dataset.anchor = block.anchor ?? "center";
      element.dataset.orientation = block.orientation ?? "horizontal";
      element.dataset.variant = block.variant ?? "standard";
      element.textContent = this.text(block.text);
      this.extras.append(element);
    }
  }

  private togglePlayback(): void {
    this.playing = !this.playing;
    this.playButton.textContent = this.playing ? "Pause" : "Play";
    if (this.playing) this.resumePlayback();
    else this.pausePlayback();
  }

  private pausePlayback(): void {
    this.activeAdapter?.pause?.();
    if (this.sequenceTimer !== null) window.clearInterval(this.sequenceTimer);
    this.sequenceTimer = null;
  }

  private prepareSequenceStart(scene: StoryScene): void {
    const playback = scene.playback;
    if (!playback || playback.mode !== "sequence" || playback.times.length === 0) return;
    this.sequenceSceneIndex = this.index;
    this.sequenceIndex = 0;
    this.sequenceDirection = 1;
    const time = Date.parse(playback.times[0]);
    this.activeAdapter?.setTime?.(time);
    this.setActiveTime(time);
  }

  private resumePlayback(): void {
    if (!this.playing || document.hidden) return;
    const playback = documents.story.scenes[this.index].playback;
    if (!playback || playback.mode === "none") return;
    if (playback.mode === "autoplay") {
      void this.activeAdapter?.play?.();
      return;
    }
    if (this.sequenceSceneIndex !== this.index) {
      this.sequenceSceneIndex = this.index;
      this.sequenceIndex = 0;
      this.sequenceDirection = 1;
    }
    const setSequenceTime = (): void => {
      const time = Date.parse(playback.times[this.sequenceIndex]);
      this.activeAdapter?.setTime?.(time);
      this.setActiveTime(time);
    };
    setSequenceTime();
    this.sequenceTimer = window.setInterval(() => {
      const next = advanceStorySequence(
        this.sequenceIndex,
        this.sequenceDirection,
        playback.times.length,
        playback.direction ?? "loop",
      );
      this.sequenceIndex = next.index;
      this.sequenceDirection = next.direction;
      setSequenceTime();
    }, playback.intervalMs);
  }

  private setActiveTime(time: number): void {
    const accepted = this.timePresentation.accept(time);
    if (accepted === null) {
      this.timestamp.textContent = "";
      this.timestamp.hidden = true;
      return;
    }
    this.timestamp.hidden = false;
    this.timestamp.textContent = formatTime(accepted, this.locale);
    this.chartCursor(accepted);
  }

  private text(value: Record<string, string>): string {
    return resolveLocalizedText(value, this.locale, documents.story.defaultLocale, documents.story.fallbackLocales);
  }

  private setStatus(message: string, error = false): void {
    this.status.textContent = message;
    this.status.hidden = !message;
    this.status.classList.toggle("is-error", error);
  }
}
