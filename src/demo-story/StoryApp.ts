import maplibregl, { type GeoJSONSource, type PropertyValueSpecification } from "maplibre-gl";
import { catalog, requireCatalogLayer } from "../catalog";
import { Zartigl, type ZarrPointSeriesResult } from "../lib";
import ensoJson from "./data/enso.json";
import { renderArcticChart, renderChartStatus, renderEnsoChart, renderMayotteChart } from "./charts/StoryCharts";
import { ARCTIC_POINT, ENSO_REGION_COLORS, MAYOTTE_POINT, MAYOTTE_TIMES, scenes } from "./scenes";
import type { EnsoStoryData, StoryScene } from "./types";

const ensoData = ensoJson as EnsoStoryData;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const ENSO_LAYER_IDS = ["enso-region-fill", "enso-region-line", "enso-region-label"] as const;
const ENSO_COLOR_EXPRESSION: PropertyValueSpecification<string> = [
  "match",
  ["get", "id"],
  "nino-12", ENSO_REGION_COLORS["nino-12"],
  "nino-3", ENSO_REGION_COLORS["nino-3"],
  "nino-34", ENSO_REGION_COLORS["nino-34"],
  "nino-4", ENSO_REGION_COLORS["nino-4"],
  "#ffffff",
];
const CHIDO_TRACK: GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { kind: "track", source: "NOAA IBTrACS v04r01" },
      geometry: {
        type: "LineString",
        coordinates: [[46.7, -12.1], [46.1, -12.3], [45.4, -12.6], [44.8, -12.9], [44.1, -13.1], [43.5, -13.2], [42.8, -13.2]],
      },
    },
    ...[
      [46.7, -12.1, "00"], [46.1, -12.3, "03"], [45.4, -12.6, "06"], [44.8, -12.9, "09"],
      [44.1, -13.1, "12"], [43.5, -13.2, "15"], [42.8, -13.2, "18"],
    ].map(([longitude, latitude, hour]) => ({
      type: "Feature" as const,
      properties: { kind: "position", label: `${hour} UTC` },
      geometry: { type: "Point" as const, coordinates: [longitude as number, latitude as number] },
    })),
  ],
};

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing story element: ${selector}`);
  return element;
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(ms));
}

function mapStyle(): string {
  const token = import.meta.env.MAPTILER_TOKEN;
  return token
    ? `https://api.maptiler.com/maps/satellite-v4/style.json?key=${token}`
    : "https://demotiles.maplibre.org/style.json";
}

function ensoFeatureCollection(): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  for (const region of ensoData.regions) {
    const { west, south, east, north } = region.bounds;
    const parts = east < west ? [[west, 180], [-180, east]] : [[west, east]];
    for (const [partWest, partEast] of parts) {
      features.push({
        type: "Feature",
        properties: { id: region.id, label: region.label },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [partWest, south], [partEast, south], [partEast, north],
            [partWest, north], [partWest, south],
          ]],
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export class StoryApp {
  private readonly story = required<HTMLElement>("#story");
  private readonly signal = required<HTMLElement>("#signal");
  private readonly title = required<HTMLElement>("#title");
  private readonly description = required<HTMLElement>("#description");
  private readonly timestamp = required<HTMLElement>("#timestamp");
  private readonly analysis = required<HTMLElement>("#analysis");
  private readonly chart = required<HTMLElement>("#chart");
  private readonly provenance = required<HTMLElement>("#provenance");
  private readonly status = required<HTMLElement>("#status");
  private readonly counter = required<HTMLElement>("#counter");
  private readonly progress = required<HTMLElement>("#progress");
  private readonly previous = required<HTMLButtonElement>("#previous");
  private readonly next = required<HTMLButtonElement>("#next");
  private readonly playButton = required<HTMLButtonElement>("#play");

  private map: maplibregl.Map | null = null;
  private zartigl: Zartigl | null = null;
  private index = 0;
  private generation = 0;
  private chartCursor: (time: number) => void = () => undefined;
  private mayotteTimer: number | null = null;
  private mayotteIndex = 0;
  private mayotteDirection: 1 | -1 = 1;
  private playing = true;
  private wheelLockedUntil = 0;

  async start(): Promise<void> {
    this.bindEvents();
    this.renderStatic(scenes[0]);
    const map = new maplibregl.Map({
      container: "map",
      style: mapStyle(),
      center: scenes[0].camera!.center,
      zoom: scenes[0].camera!.zoom,
      maxZoom: 9,
      attributionControl: false,
    });
    this.map = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");

    await new Promise<void>((resolve, reject) => {
      map.once("load", () => resolve());
      map.once("error", (event) => reject(event.error ?? new Error("Map failed to load")));
    }).catch((error: unknown) => {
      this.setStatus(error instanceof Error ? error.message : "Map failed to load", true);
      throw error;
    });

    map.setProjection({ type: "globe" });
    this.addReferenceLayers();
    this.zartigl = new Zartigl({
      id: "zartigl-story",
      map,
      catalog,
      backend: "geovideo",
      geoVideo: { autoplay: true, loop: true, playbackRate: 1 },
      visible: false,
      before: "enso-region-fill",
    });
    this.zartigl.on("loading", () => this.setStatus("Loading environmental data…"));
    this.zartigl.on("loaded", () => this.setStatus(""));
    this.zartigl.on("error", (error) => this.setStatus(error.message, true));
    this.zartigl.on("timeChange", (time) => this.setActiveTime(time));
    this.setStatus("");
    await this.activate(0);
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
    const target = Math.max(0, Math.min(scenes.length - 1, this.index + delta));
    if (target !== this.index) await this.activate(target);
  }

  private async activate(index: number): Promise<void> {
    const scene = scenes[index];
    const generation = ++this.generation;
    this.index = index;
    this.stopMayotteLoop();
    this.chartCursor = () => undefined;
    this.renderStatic(scene);
    this.moveCamera(scene);
    this.showEnsoRegions(scene.id === "enso");
    this.showChidoTrack(scene.id === "mayotte");

    const z = this.zartigl;
    if (!z || !scene.layerId) {
      z?.hide();
      return;
    }

    z.show();
    this.analysis.hidden = false;
    renderChartStatus(this.chart, "Loading measurements…");
    this.setStatus("Loading environmental data…");
    try {
      if (z.getTimeMeta({ full: true }).size) z.setTimeRange(null);
      await z.setLayer(scene.layerId);
      if (generation !== this.generation) return;
      if (scene.timeRange) z.setTimeRange(scene.timeRange);
      if (scene.settings) z.updateSettings(scene.settings);

      if (scene.id === "arctic") await this.loadArctic(scene, z, generation);
      if (scene.id === "enso") this.loadEnso(z);
      if (scene.id === "mayotte") await this.loadMayotte(z, generation);
      if (generation !== this.generation) return;
      this.setStatus("");
      if (this.playing) this.resumePlayback();
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : "Unable to load this scene";
      renderChartStatus(this.chart, message);
      this.setStatus(message, true);
    }
  }

  private async loadArctic(scene: StoryScene, z: Zartigl, generation: number): Promise<void> {
    const result = await z.queryTimeSeries({
      longitude: ARCTIC_POINT.longitude,
      latitude: ARCTIC_POINT.latitude,
      maxPoints: 420,
    });
    if (generation !== this.generation) return;
    this.chartCursor = renderArcticChart(this.chart, result, "sithick", z.getVariableMeta().units ?? "m");
    this.provenance.textContent = this.catalogProvenance(scene.layerId!, result);
    this.setActiveTime(z.getTimeMeta().current ?? z.getTimeMeta().min);
  }

  private loadEnso(z: Zartigl): void {
    this.raiseEnsoRegions();
    this.chartCursor = renderEnsoChart(this.chart, ensoData);
    this.provenance.textContent = `Area-weighted native-grid means · ${ensoData.source.datasetId} · generated ${formatTime(Date.parse(ensoData.generatedAt))}`;
    this.setActiveTime(z.getTimeMeta().current ?? z.getTimeMeta().min);
  }

  private async loadMayotte(z: Zartigl, generation: number): Promise<void> {
    this.raiseChidoTrack();
    const result = await z.queryTimeSeries({
      longitude: MAYOTTE_POINT.longitude,
      latitude: MAYOTTE_POINT.latitude,
      maxPoints: 180,
    });
    if (generation !== this.generation) return;
    this.chartCursor = renderMayotteChart(this.chart, result);
    this.provenance.textContent = `Hourly sea-surface wind (not station gust): ${requireCatalogLayer("surface-wind").dataset.id} · nearest grid point ${result.latitude.toFixed(4)}°, ${result.longitude.toFixed(4)}° · Track: NOAA IBTrACS v04r01`;
    this.mayotteIndex = 3;
    this.mayotteDirection = 1;
    this.setMayotteTime();
  }

  private catalogProvenance(layerId: string, result: ZarrPointSeriesResult): string {
    const layer = requireCatalogLayer(layerId);
    return `${layer.dataset.id} · nearest grid point ${result.latitude.toFixed(3)}°, ${result.longitude.toFixed(3)}° · ${result.points.length} samples`;
  }

  private renderStatic(scene: StoryScene): void {
    this.story.dataset.scene = scene.id;
    this.story.style.setProperty("--accent-hue", String(scene.accentHue));
    this.signal.textContent = scene.signal;
    this.title.innerHTML = scene.title.replace(/, /g, ",<br>").replace(" on ", "<br>on ");
    this.description.textContent = scene.description;
    this.timestamp.textContent = "";
    this.counter.textContent = `${String(this.index + 1).padStart(2, "0")} / ${String(scenes.length).padStart(2, "0")}`;
    this.progress.style.width = `${((this.index + 1) / scenes.length) * 100}%`;
    this.previous.disabled = this.index === 0;
    this.next.disabled = this.index === scenes.length - 1;
    this.analysis.hidden = !scene.chart;
    this.playButton.hidden = !scene.layerId;
    this.playButton.textContent = this.playing ? "Pause" : "Play";
    this.chart.replaceChildren();
    this.provenance.textContent = "";
  }

  private moveCamera(scene: StoryScene): void {
    if (!this.map || !scene.camera) return;
    const options = {
      ...scene.camera,
      duration: REDUCED_MOTION.matches ? 0 : 1400,
      essential: false,
    };
    this.map.flyTo(options);
  }

  private setActiveTime(time: number): void {
    if (!Number.isFinite(time)) return;
    this.timestamp.textContent = formatTime(time);
    this.chartCursor(time);
  }

  private togglePlayback(): void {
    this.playing = !this.playing;
    this.playButton.textContent = this.playing ? "Pause" : "Play";
    if (this.playing) this.resumePlayback();
    else this.pausePlayback();
  }

  private pausePlayback(): void {
    this.zartigl?.pause();
    this.stopMayotteLoop();
  }

  private resumePlayback(): void {
    const scene = scenes[this.index];
    if (scene.id === "mayotte") {
      this.startMayotteLoop();
      return;
    }
    if (scene.id === "arctic" || scene.id === "enso") void this.zartigl?.play();
  }

  private startMayotteLoop(): void {
    this.stopMayotteLoop();
    if (!this.playing || document.hidden) return;
    this.mayotteTimer = window.setInterval(() => {
      const next = this.mayotteIndex + this.mayotteDirection;
      if (next >= MAYOTTE_TIMES.length || next < 0) {
        this.mayotteDirection = this.mayotteDirection === 1 ? -1 : 1;
      }
      this.mayotteIndex += this.mayotteDirection;
      this.setMayotteTime();
    }, 2000);
  }

  private stopMayotteLoop(): void {
    if (this.mayotteTimer !== null) window.clearInterval(this.mayotteTimer);
    this.mayotteTimer = null;
  }

  private setMayotteTime(): void {
    const time = Date.parse(MAYOTTE_TIMES[this.mayotteIndex]);
    this.zartigl?.setTime(time);
    this.setActiveTime(time);
  }

  private setStatus(message: string, error = false): void {
    this.status.textContent = message;
    this.status.hidden = !message;
    this.status.classList.toggle("is-error", error);
  }

  private addReferenceLayers(): void {
    if (!this.map) return;
    this.map.addSource("enso-regions", { type: "geojson", data: ensoFeatureCollection() });
    this.map.addLayer({
      id: "enso-region-fill",
      type: "fill",
      source: "enso-regions",
      paint: { "fill-color": ENSO_COLOR_EXPRESSION, "fill-opacity": 0.12 },
      layout: { visibility: "none" },
    });
    this.map.addLayer({
      id: "enso-region-line",
      type: "line",
      source: "enso-regions",
      paint: { "line-color": ENSO_COLOR_EXPRESSION, "line-width": 2, "line-opacity": 0.88 },
      layout: { visibility: "none" },
    });
    this.map.addLayer({
      id: "enso-region-label",
      type: "symbol",
      source: "enso-regions",
      layout: {
        visibility: "none",
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": ENSO_COLOR_EXPRESSION,
        "text-halo-color": "#100b16",
        "text-halo-width": 1.5,
        "text-halo-blur": 0,
      },
    });
    this.map.addSource("chido-track", { type: "geojson", data: CHIDO_TRACK });
    this.map.addLayer({
      id: "chido-track-line",
      type: "line",
      source: "chido-track",
      filter: ["==", ["get", "kind"], "track"],
      layout: { visibility: "none" },
      paint: { "line-color": "#8df097", "line-width": 2, "line-opacity": 0.85, "line-dasharray": [2, 2] },
    });
    this.map.addLayer({
      id: "chido-track-points",
      type: "circle",
      source: "chido-track",
      filter: ["==", ["get", "kind"], "position"],
      layout: { visibility: "none" },
      paint: { "circle-radius": 4, "circle-color": "#8df097", "circle-stroke-color": "#111018", "circle-stroke-width": 1.5 },
    });
    this.map.addLayer({
      id: "chido-track-labels",
      type: "symbol",
      source: "chido-track",
      filter: ["==", ["get", "kind"], "position"],
      layout: { visibility: "none", "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1.1] },
      paint: { "text-color": "#d7ffda", "text-halo-color": "#111018", "text-halo-width": 1.5 },
    });
  }

  private showEnsoRegions(show: boolean): void {
    if (!this.map?.getSource("enso-regions")) return;
    for (const id of ENSO_LAYER_IDS) {
      this.map.setLayoutProperty(id, "visibility", show ? "visible" : "none");
    }
  }

  private raiseEnsoRegions(): void {
    if (!this.map) return;
    for (const id of ENSO_LAYER_IDS) {
      if (this.map.getLayer(id)) this.map.moveLayer(id);
    }
  }

  private showChidoTrack(show: boolean): void {
    if (!this.map?.getSource("chido-track")) return;
    for (const id of ["chido-track-line", "chido-track-points", "chido-track-labels"]) {
      this.map.setLayoutProperty(id, "visibility", show ? "visible" : "none");
    }
  }

  private raiseChidoTrack(): void {
    if (!this.map) return;
    for (const id of ["chido-track-line", "chido-track-points", "chido-track-labels"]) {
      if (this.map.getLayer(id)) this.map.moveLayer(id);
    }
  }
}
