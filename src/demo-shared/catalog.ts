// ── Shared catalog types & helpers ───────────────────────────────────

export interface CatalogDimension {
  axis: string;
  size: number;
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
  chunk_size: number;
  units: string;
}

export interface LayerDefaults {
  palette?: string;
  renderMode?: string;
  particleDensity?: number;
  speedMin?: number;
  speedMax?: number;
  fadeMin?: number;
  fadeMax?: number;
  dropRate?: number;
  dropRateBump?: number;
  opacity?: number;
  logScale?: boolean;
  vibrance?: number;
}

export interface CatalogView {
  id: string;
  label: string;
  description?: string;
  category?: string;
  type: "vector" | "scalar";
  source_dataset: string;
  zarr_url_geo: string;
  zarr_url_time?: string;
  variable?: string;
  variable_u?: string;
  variable_v?: string;
  variable_meta?: { standard_name: string; units: string };
  dimensions: Record<string, CatalogDimension>;
  vertical_label?: string;
  defaults?: LayerDefaults;
}

export interface Catalog {
  generated: string;
  views: CatalogView[];
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatVertical(v: number, label: string): string {
  if (label === "pressure") return `${Math.round(v)} hPa`;
  if (v < 10) return `${v.toFixed(2)} m`;
  if (v < 100) return `${v.toFixed(1)} m`;
  return `${Math.round(v)} m`;
}

/** Return the [key, dim] entry for the z-axis dimension, if any. */
export function getVerticalDim(
  view: CatalogView,
): [string, CatalogDimension] | undefined {
  return Object.entries(view.dimensions).find(([, d]) => d.axis === "z");
}
