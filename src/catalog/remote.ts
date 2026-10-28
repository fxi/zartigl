/**
 * The live catalog: the built-in catalog as published on the zartigl bucket
 * on every change, so apps built against an older package (MapX) see layers
 * added since. The bundled catalog is the fallback when it cannot be read.
 */

import catalogJson from "./catalog.json";
import { version as engineVersion } from "../../package.json";
import type { Catalog } from "./types";

/** Live catalog of schema 2; a schema 3 would publish under `v3/`. */
export const CATALOG_URL =
  "https://sos-ch-gva-2.exo.io/mapx-zartigl/catalog/v2/catalog.json";

/** A published catalog: the catalog plus the oldest engine that renders it all. */
export type PublishedCatalog = Catalog & { minEngine?: string };

export interface LoadCatalogOptions {
  /** Give up on the live catalog after this delay. */
  timeoutMs?: number;
  /** Used when the live catalog cannot be read; the bundled one by default. */
  fallback?: Catalog;
  /** Where warnings go; console.warn by default. */
  warn?: (message: string) => void;
  /** For tests: the fetch to use. */
  fetch?: typeof fetch;
}

export interface LoadedCatalog {
  catalog: Catalog;
  source: "remote" | "bundled";
}

/** -1, 0 or 1 as `a` is older than, equal to or newer than `b` (x.y.z). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] < y[i] ? -1 : 1;
    }
  }
  return 0;
}

function isCatalog(value: unknown): value is PublishedCatalog {
  const candidate = value as Partial<Catalog> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.schemaVersion === 2 &&
    Array.isArray(candidate.layers)
  );
}

/**
 * The live catalog, or `fallback` (the bundled catalog) when it cannot be
 * fetched or is not a schema 2 catalog. A catalog that needs a newer engine
 * still loads, with a warning: its new style keys degrade, they do not fail.
 */
export async function loadCatalog(
  url: string = CATALOG_URL,
  options: LoadCatalogOptions = {},
): Promise<LoadedCatalog> {
  const {
    timeoutMs = 5000,
    fallback = catalogJson as Catalog,
    warn = (message: string) => console.warn(message),
    fetch: fetchCatalog = globalThis.fetch,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchCatalog(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const remote: unknown = await response.json();
    if (!isCatalog(remote)) {
      throw new Error("not a schema 2 catalog");
    }
    if (
      remote.minEngine &&
      compareVersions(engineVersion, remote.minEngine) < 0
    ) {
      warn(
        `[zartigl] the catalog at ${url} needs zartigl ${remote.minEngine}; this is ${engineVersion}: newer style keys are ignored`,
      );
    }
    return { catalog: remote, source: "remote" };
  } catch (error) {
    warn(
      `[zartigl] live catalog unavailable (${error instanceof Error ? error.message : String(error)}): using the bundled catalog`,
    );
    return { catalog: fallback, source: "bundled" };
  } finally {
    clearTimeout(timer);
  }
}
