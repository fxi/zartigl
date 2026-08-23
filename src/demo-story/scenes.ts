import type { StoryScene } from "./types";

export const ARCTIC_POINT = { longitude: -5.667, latitude: 81.833 } as const;
export const MAYOTTE_POINT = { longitude: 43.813, latitude: -13.188 } as const;
export const ENSO_REGION_COLORS: Record<string, string> = {
  "nino-12": "#ff4df0",
  "nino-3": "#00ddff",
  "nino-34": "#ffb000",
  "nino-4": "#39f58a",
};

export const MAYOTTE_TIMES = [
  "2024-12-14T08:00:00.000Z",
  "2024-12-14T10:00:00.000Z",
  "2024-12-14T12:00:00.000Z",
  "2024-12-14T14:00:00.000Z",
  "2024-12-14T16:00:00.000Z",
  "2024-12-14T18:00:00.000Z",
  "2024-12-14T20:00:00.000Z",
] as const;

export const scenes: StoryScene[] = [
  {
    id: "intro",
    signal: "Planetary Signal — A live-data story",
    title: "The ocean is speaking",
    description: "Three signals, read directly from cloud-native environmental data.",
    accentHue: 300,
    camera: { center: [18, 12], zoom: 1.25, pitch: 0 },
  },
  {
    id: "arctic",
    signal: "Signal 01 — Arctic",
    title: "Ice, frame by frame",
    description: "Daily sea-ice thickness across the Arctic, paired with the record at 5.667°W, 81.833°N.",
    accentHue: 210,
    layerId: "sea-ice-thickness",
    camera: { center: [ARCTIC_POINT.longitude, ARCTIC_POINT.latitude], zoom: 2.35, pitch: 0 },
    settings: { palette: "ice", opacity: 0.9, logScale: false, vibrance: 0.1, colorDomain: [0, 5] },
    chart: "arctic",
  },
  {
    id: "enso",
    signal: "Signal 02 — Equatorial Pacific",
    title: "Four windows on ENSO",
    description: "Sea-surface temperature anomalies across the Niño 1+2, 3, 3.4 and 4 monitoring regions.",
    accentHue: 28,
    layerId: "sea-surface-temperature-anomaly",
    camera: { center: [-145, 0], zoom: 1.55, pitch: 0 },
    settings: { palette: "balance", opacity: 0.9, logScale: false, vibrance: 0.1, colorDomain: [-3, 3] },
    chart: "enso",
  },
  {
    id: "mayotte",
    signal: "Signal 03 — Mayotte, 14 December 2024",
    title: "Following Chido west",
    description: "Hourly sea-surface wind follows Chido west after its passage over Mayotte.",
    accentHue: 145,
    layerId: "surface-wind",
    camera: { center: [42.252791, -13.811], zoom: 7.832, bearing: 34.69, pitch: 60 },
    timeRange: { start: "2024-12-14T06:00:00.000Z", end: "2024-12-14T22:00:00.000Z" },
    settings: {
      palette: "rdylbu",
      particleDensity: 0.15,
      speed: 5.9,
      fade: 0.7,
      renderMode: "particles",
      opacity: 0.9,
      logScale: true,
      vibrance: 1,
      colorDomain: null,
    },
    chart: "mayotte",
  },
  {
    id: "outro",
    signal: "Zartigl — Browser-native Zarr",
    title: "Follow the signal",
    description: "Maps, timelines and measurements share one source of truth: the dataset itself.",
    accentHue: 300,
    camera: { center: [22, 8], zoom: 1.2, pitch: 0 },
  },
];
