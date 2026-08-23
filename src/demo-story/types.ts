import type { ZartiglSettings } from "../lib";

export type StorySceneId = "intro" | "arctic" | "enso" | "mayotte" | "outro";

export interface StoryScene {
  id: StorySceneId;
  signal: string;
  title: string;
  description: string;
  accentHue: number;
  layerId?: string;
  camera?: {
    center: [number, number];
    zoom: number;
    bearing?: number;
    pitch?: number;
  };
  timeRange?: { start: string; end: string };
  settings?: Partial<ZartiglSettings>;
  chart?: "arctic" | "enso" | "mayotte";
}

export interface RegionBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface RegionStatsPoint {
  time: string;
  mean: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export interface EnsoRegionSeries {
  id: string;
  label: string;
  bounds: RegionBounds;
  points: RegionStatsPoint[];
}

export interface EnsoStoryData {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    layerId: string;
    datasetId: string;
    storeUrl: string;
    variable: string;
    unit: string;
    method: string;
    timeStart: string;
    timeEnd: string;
  };
  regions: EnsoRegionSeries[];
}
