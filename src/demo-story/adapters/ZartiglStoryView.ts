import maplibregl, { type PropertyValueSpecification } from "maplibre-gl";
import type { TimeRange, Zartigl, ZartiglSettings } from "../../lib";
import type { StoryAnchor, StoryScene, StoryViewAdapter, StoryViewDefinition } from "../runtime";
import ensoJson from "../data/enso.json";
import chidoTrackJson from "../data/chido-track.json";
import { ENSO_REGION_COLORS } from "../scenes";
import type { EnsoStoryData } from "../types";

export interface CameraConfig {
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
}

export interface CameraTransitionConfig {
  method?: "flyTo" | "jumpTo";
  durationMs?: number;
}

interface ZartiglViewConfig extends Record<string, unknown> {
  layerId?: string;
  sourceId?: string;
  camera: CameraConfig;
  transition?: CameraTransitionConfig;
  anchor?: StoryAnchor;
  timeRange?: TimeRange;
  settings?: Partial<ZartiglSettings>;
  overlays?: string[];
}

interface ZartiglStoryViewCallbacks {
  status(message: string, error?: boolean): void;
  time(time: number): void;
}

export interface ChidoTrackData {
  storm: { id: string; name: string };
  source: { name: string; version: string };
  points: Array<{ time: string; label: string; longitude: number; latitude: number }>;
}

export interface ArcticMeasurementPoint {
  longitude: number;
  latitude: number;
}

const chidoTrack = chidoTrackJson as ChidoTrackData;

export function arcticMeasurementFeature(point: ArcticMeasurementPoint): GeoJSON.Feature<GeoJSON.Point> {
  const latitude = `${Math.abs(point.latitude).toFixed(3)}°${point.latitude >= 0 ? "N" : "S"}`;
  const longitude = `${Math.abs(point.longitude).toFixed(3)}°${point.longitude >= 0 ? "E" : "W"}`;
  return {
    type: "Feature",
    properties: { label: `${latitude} · ${longitude}` },
    geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
  };
}

export function storyOverlayVisibility(overlays: readonly string[]): {
  arcticMeasurement: boolean;
  ensoRegions: boolean;
  chidoTrack: boolean;
} {
  return {
    arcticMeasurement: overlays.includes("arctic-measurement"),
    ensoRegions: overlays.includes("enso-regions"),
    chidoTrack: overlays.includes("chido-track"),
  };
}

export function nearestChidoTrackPoint(points: ChidoTrackData["points"], time: number): ChidoTrackData["points"][number] {
  let nearest = points[0];
  let distance = Math.abs(Date.parse(nearest.time) - time);
  for (const point of points.slice(1)) {
    const nextDistance = Math.abs(Date.parse(point.time) - time);
    if (nextDistance < distance) {
      nearest = point;
      distance = nextDistance;
    }
  }
  return nearest;
}

const ENSO_LAYER_IDS = ["enso-region-fill", "enso-region-line", "enso-region-label"] as const;
const ARCTIC_MEASUREMENT_LAYER_IDS = ["arctic-measurement-ring", "arctic-measurement-crosshair", "arctic-measurement-label"] as const;
const CHIDO_LAYER_IDS = ["chido-track-line", "chido-track-points", "chido-track-labels", "chido-track-active"] as const;
const ENSO_COLOR_EXPRESSION: PropertyValueSpecification<string> = [
  "match", ["get", "id"],
  "nino-12", ENSO_REGION_COLORS["nino-12"],
  "nino-3", ENSO_REGION_COLORS["nino-3"],
  "nino-34", ENSO_REGION_COLORS["nino-34"],
  "nino-4", ENSO_REGION_COLORS["nino-4"],
  "#ffffff",
];

function assertConfig(config: Record<string, unknown>): asserts config is ZartiglViewConfig {
  const camera = config.camera;
  if (!camera || typeof camera !== "object" || !Array.isArray((camera as CameraConfig).center)) {
    throw new Error("A zartigl-map view requires a camera");
  }
  const transition = config.transition;
  if (transition !== undefined) {
    if (!transition || typeof transition !== "object") throw new Error("A zartigl-map transition must be an object");
    const value = transition as CameraTransitionConfig;
    if (value.method !== undefined && value.method !== "flyTo" && value.method !== "jumpTo") {
      throw new Error("A zartigl-map transition method must be flyTo or jumpTo");
    }
    if (value.durationMs !== undefined && (!Number.isFinite(value.durationMs) || value.durationMs < 0)) {
      throw new Error("A zartigl-map transition durationMs must be non-negative");
    }
  }
}

export function cameraPadding(anchor: StoryAnchor | undefined, width: number, height: number): maplibregl.PaddingOptions {
  if (height > width * 1.15) {
    const x = Math.round(width * 0.16);
    const top = Math.round(height * 0.3);
    const bottom = Math.round(height * 0.34);
    switch (anchor) {
      case "top-right": return { top: 0, right: 0, bottom, left: x };
      case "top-left": return { top: 0, right: x, bottom, left: 0 };
      case "bottom-right": return { top, right: 0, bottom: 0, left: x };
      case "bottom-left": return { top, right: x, bottom: 0, left: 0 };
      default: return { top: 0, right: 0, bottom: 0, left: 0 };
    }
  }
  const x = Math.round(width * 0.22);
  const y = Math.round(height * 0.12);
  switch (anchor) {
    case "top-right": return { top: 0, right: 0, bottom: y * 2, left: x * 2 };
    case "top-left": return { top: 0, right: x * 2, bottom: y * 2, left: 0 };
    case "bottom-right": return { top: y * 2, right: 0, bottom: 0, left: x * 2 };
    case "bottom-left": return { top: y * 2, right: x * 2, bottom: 0, left: 0 };
    default: return { top: 0, right: 0, bottom: 0, left: 0 };
  }
}

export function resolveCameraTransition(
  config: Pick<ZartiglViewConfig, "camera" | "anchor" | "transition">,
  viewport: { width: number; height: number },
  reducedMotion: boolean,
): { method: "flyTo" | "jumpTo"; options: maplibregl.FlyToOptions & maplibregl.JumpToOptions } {
  const method = reducedMotion ? "jumpTo" : config.transition?.method ?? "flyTo";
  return {
    method,
    options: {
      ...config.camera,
      padding: cameraPadding(config.anchor, viewport.width, viewport.height),
      duration: method === "jumpTo" ? 0 : config.transition?.durationMs ?? 1400,
      essential: false,
    },
  };
}

export class ZartiglStoryView implements StoryViewAdapter {
  private generation = 0;

  constructor(
    private readonly map: maplibregl.Map,
    readonly zartigl: Zartigl,
    private readonly callbacks: ZartiglStoryViewCallbacks,
  ) {
    this.addReferenceLayers();
    zartigl.on("loading", () => callbacks.status("Loading environmental data…"));
    zartigl.on("loaded", () => callbacks.status(""));
    zartigl.on("error", (error) => callbacks.status(error.message, true));
    zartigl.on("timeChange", (time) => {
      this.updateChidoTrack(time);
      callbacks.time(time);
    });
  }

  async activate(view: StoryViewDefinition, _scene: StoryScene): Promise<void> {
    assertConfig(view.config);
    const config = view.config;
    const generation = ++this.generation;
    this.moveCamera(config);
    this.showOverlays(config.overlays ?? []);

    if (!config.layerId) {
      this.zartigl.hide();
      this.callbacks.status("");
      return;
    }
    this.zartigl.show();
    this.callbacks.status("Loading environmental data…");
    if (this.zartigl.getTimeMeta({ full: true }).size) this.zartigl.setTimeRange(null);
    await this.zartigl.setLayer(config.layerId, config.sourceId ?? "auto");
    if (generation !== this.generation) return;
    if (config.timeRange) this.zartigl.setTimeRange(config.timeRange);
    if (config.settings) this.zartigl.updateSettings(config.settings);
    this.callbacks.status("");
  }

  play(): Promise<void> { return this.zartigl.play(); }
  pause(): void { this.zartigl.pause(); }
  setTime(time: number): void {
    this.updateChidoTrack(time);
    this.zartigl.setTime(time);
  }
  setArcticMeasurementPoint(point?: ArcticMeasurementPoint): void {
    const source = this.map.getSource("arctic-measurement") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const features = point ? [arcticMeasurementFeature(point)] : [];
    source.setData({ type: "FeatureCollection", features });
  }
  destroy(): void { this.zartigl.destroy(); }

  private moveCamera(config: ZartiglViewConfig): void {
    const transition = resolveCameraTransition(
      config,
      { width: window.innerWidth, height: window.innerHeight },
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    this.map.stop();
    if (transition.method === "jumpTo") this.map.jumpTo(transition.options);
    else this.map.flyTo(transition.options);
  }

  private showOverlays(overlays: readonly string[]): void {
    const visibility = storyOverlayVisibility(overlays);
    for (const id of ARCTIC_MEASUREMENT_LAYER_IDS) this.map.setLayoutProperty(id, "visibility", visibility.arcticMeasurement ? "visible" : "none");
    for (const id of ENSO_LAYER_IDS) this.map.setLayoutProperty(id, "visibility", visibility.ensoRegions ? "visible" : "none");
    for (const id of CHIDO_LAYER_IDS) this.map.setLayoutProperty(id, "visibility", visibility.chidoTrack ? "visible" : "none");
    if (visibility.arcticMeasurement) ARCTIC_MEASUREMENT_LAYER_IDS.forEach((id) => this.map.moveLayer(id));
    if (visibility.ensoRegions) ENSO_LAYER_IDS.forEach((id) => this.map.moveLayer(id));
    if (visibility.chidoTrack) CHIDO_LAYER_IDS.forEach((id) => this.map.moveLayer(id));
  }

  private addReferenceLayers(): void {
    const data = ensoJson as EnsoStoryData;
    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
    for (const region of data.regions) {
      const { west, south, east, north } = region.bounds;
      const parts = east < west ? [[west, 180], [-180, east]] : [[west, east]];
      for (const [partWest, partEast] of parts) {
        features.push({ type: "Feature", properties: { id: region.id, label: region.label }, geometry: { type: "Polygon", coordinates: [[[partWest, south], [partEast, south], [partEast, north], [partWest, north], [partWest, south]]] } });
      }
    }
    this.map.addSource("enso-regions", { type: "geojson", data: { type: "FeatureCollection", features } });
    this.map.addLayer({ id: "enso-region-fill", type: "fill", source: "enso-regions", paint: { "fill-color": ENSO_COLOR_EXPRESSION, "fill-opacity": 0.12 }, layout: { visibility: "none" } });
    this.map.addLayer({ id: "enso-region-line", type: "line", source: "enso-regions", paint: { "line-color": ENSO_COLOR_EXPRESSION, "line-width": 2, "line-opacity": 0.88 }, layout: { visibility: "none" } });
    this.map.addLayer({ id: "enso-region-label", type: "symbol", source: "enso-regions", layout: { visibility: "none", "text-field": ["get", "label"], "text-size": 12 }, paint: { "text-color": ENSO_COLOR_EXPRESSION, "text-halo-color": "#100b16", "text-halo-width": 1.5 } });

    this.map.addSource("arctic-measurement", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.map.addLayer({ id: "arctic-measurement-ring", type: "circle", source: "arctic-measurement", layout: { visibility: "none" }, paint: { "circle-radius": 9, "circle-color": "rgba(17, 16, 24, 0.28)", "circle-stroke-color": "#67d9ff", "circle-stroke-width": 2 } });
    this.map.addLayer({ id: "arctic-measurement-crosshair", type: "symbol", source: "arctic-measurement", layout: { visibility: "none", "text-field": "+", "text-size": 22, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#f7f3ff", "text-halo-color": "#111018", "text-halo-width": 1 } });
    this.map.addLayer({ id: "arctic-measurement-label", type: "symbol", source: "arctic-measurement", layout: { visibility: "none", "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1.8], "text-anchor": "top", "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#dff8ff", "text-halo-color": "#111018", "text-halo-width": 1.5 } });

    const track: GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point> = { type: "FeatureCollection", features: [
      {
        type: "Feature",
        properties: { kind: "track", source: `${chidoTrack.source.name} ${chidoTrack.source.version}`, stormId: chidoTrack.storm.id },
        geometry: { type: "LineString", coordinates: chidoTrack.points.map((point) => [point.longitude, point.latitude]) },
      },
      ...chidoTrack.points.map((point) => ({
        type: "Feature" as const,
        properties: { kind: "position", label: point.label, time: point.time },
        geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] },
      })),
    ] };
    this.map.addSource("chido-track", { type: "geojson", data: track });
    this.map.addLayer({ id: "chido-track-line", type: "line", source: "chido-track", filter: ["==", ["get", "kind"], "track"], layout: { visibility: "none" }, paint: { "line-color": "#8df097", "line-width": 2, "line-opacity": 0.85, "line-dasharray": [2, 2] } });
    this.map.addLayer({ id: "chido-track-points", type: "circle", source: "chido-track", filter: ["==", ["get", "kind"], "position"], layout: { visibility: "none" }, paint: { "circle-radius": 4, "circle-color": "#8df097", "circle-stroke-color": "#111018", "circle-stroke-width": 1.5 } });
    this.map.addLayer({ id: "chido-track-labels", type: "symbol", source: "chido-track", filter: ["==", ["get", "kind"], "position"], layout: { visibility: "none", "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1.1] }, paint: { "text-color": "#d7ffda", "text-halo-color": "#111018", "text-halo-width": 1.5 } });
    this.map.addLayer({ id: "chido-track-active", type: "circle", source: "chido-track", filter: ["==", ["get", "time"], ""], layout: { visibility: "none" }, paint: { "circle-radius": 8, "circle-color": "#ffffff", "circle-stroke-color": "#8df097", "circle-stroke-width": 3, "circle-blur": 0.08 } });
  }

  private updateChidoTrack(time: number): void {
    if (!Number.isFinite(time) || !this.map.getLayer("chido-track-active")) return;
    const nearest = nearestChidoTrackPoint(chidoTrack.points, time);
    this.map.setFilter("chido-track-active", ["==", ["get", "time"], nearest.time]);
  }
}
