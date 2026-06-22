import catalogJson from "./catalog.json";
import type { Catalog, CatalogLayer } from "./types";

export type {
  Catalog,
  CatalogLayer,
  CatalogVariables,
  CatalogVectorDerivation,
  CatalogWmts,
} from "./types";

export const catalog = catalogJson as Catalog;

export function getCatalogLayer(id: string, data: Catalog = catalog): CatalogLayer | undefined {
  return data.layers.find((layer) => layer.id === id);
}

export function requireCatalogLayer(id: string, data: Catalog = catalog): CatalogLayer {
  const layer = getCatalogLayer(id, data);
  if (!layer) {
    throw new Error(`Unknown zartigl catalog layer: ${id}`);
  }
  return layer;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatVertical(v: number, label: string, units?: string): string {
  const unit = units?.trim();
  if (label === "pressure") return `${Math.round(v)} ${unit || "hPa"}`;
  if (unit && unit !== "m") return `${Number(v.toPrecision(5))} ${unit}`;
  if (v < 10) return `${v.toFixed(2)} m`;
  if (v < 100) return `${v.toFixed(1)} m`;
  return `${Math.round(v)} m`;
}
