import { requireCatalogEntry } from "../catalog";
import type { CatalogGeoVideoSource } from "../catalog/types";
import { getPalettes, type PaletteMeta } from "../lib/gl-util";
import {
  geoVideoChunkSources,
  isGeoVideoArchiveSource,
  loadGeoVideoIndex,
} from "../lib/geovideo-index";
import type { ParticleSettings } from "./scales";

/**
 * Demo sub-catalog: global vector GeoVideo archives of the zartigl catalog,
 * with the styling this projection demo gives them. Palettes start dark so
 * the bright trails read against the black background.
 */
export interface DemoLayer {
  /** Picker and share key; defaults to the entry id. */
  id?: string;
  /** zartigl catalog entry id of the vector field. */
  entryId: string;
  label: string;
  palette: string;
  /** Draw land opaque: off for fields that also cover land. */
  fillLand: boolean;
  /** Overrides of the catalog entry `defaults.particles` (density, speed, fade). */
  particles?: Partial<ParticleSettings>;
  /**
   * Scalar catalog entry whose GeoVideo archive colors the particles (over
   * its catalog color domain); speed then sets their brightness. Its monthly
   * chunks pair with the vector ones by start date.
   */
  tint?: { entryId: string };
}

/**
 * Month chunks of a layer's tint archive; empty without a tint or when its
 * index cannot be read, so the layer still opens, colored by speed.
 */
export async function loadTintChunks(
  layer: DemoLayer,
  loadIndex = loadGeoVideoIndex,
): Promise<CatalogGeoVideoSource[]> {
  if (!layer.tint) {
    return [];
  }
  try {
    const entry = requireCatalogEntry(layer.tint.entryId);
    const source = entry.sources.find(isGeoVideoArchiveSource);
    if (!source) {
      throw new Error(`No GeoVideo archive for tint ${entry.id}`);
    }
    return geoVideoChunkSources(
      source,
      await loadIndex(source.indexUrl),
      entry,
    );
  } catch (error) {
    console.error(error);
    return [];
  }
}

/**
 * The candidate whose sample range overlaps `chunk` the most: archives
 * sampled at different hours (six-hourly from 00:00, daily at 12:00) still
 * pair by calendar period. Null when none overlaps.
 */
export function pairChunk(
  chunk: CatalogGeoVideoSource,
  candidates: readonly CatalogGeoVideoSource[],
): CatalogGeoVideoSource | null {
  const span = (c: CatalogGeoVideoSource) => [
    Date.parse(c.temporal?.start ?? ""),
    Date.parse(c.temporal?.end ?? ""),
  ];
  const [start, end] = span(chunk);
  let best: CatalogGeoVideoSource | null = null;
  let bestOverlap = -Infinity;
  for (const candidate of candidates) {
    const [s, e] = span(candidate);
    const overlap = Math.min(end, e) - Math.max(start, s);
    if (Number.isFinite(overlap) && overlap >= 0 && overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Picker and share key of a layer. */
export function layerKey(layer: DemoLayer): string {
  return layer.id ?? layer.entryId;
}

export const DEMO_LAYERS: DemoLayer[] = [
  {
    entryId: "61a81ddd-6c8e-4020-a59f-06ef13a90419",
    label: "Ocean Velocity",
    palette: "plasma",
    fillLand: true,
  },
  {
    id: "ocean-velocity-temperature",
    entryId: "61a81ddd-6c8e-4020-a59f-06ef13a90419",
    label: "Currents × Temperature",
    // Starts bright: cold, slow water stays visible once dimmed by speed.
    palette: "thermal-alt",
    fillLand: true,
    tint: { entryId: "3db0120b-17d2-4789-9952-efcc0953ecc4" },
  },
  {
    entryId: "72aa3549-8cdf-4275-b8f7-5b32ca40a3f2",
    label: "Surface Wind",
    palette: "viridis",
    fillLand: false,
    particles: { density: 0.5, speed: 3, fade: 1 },
  },
  {
    entryId: "88f00432-ffad-4ebd-85ac-9f8de1ee5213",
    label: "Stokes Drift",
    palette: "viridis",
    fillLand: true,
  },
  {
    entryId: "bb38fd23-b0b0-4cd0-b59d-0224be3052f9",
    label: "Primary Swell",
    palette: "thermal",
    fillLand: true,
  },
  {
    entryId: "40733539-e493-448e-80b5-2a7874f47b85",
    label: "Sea Ice Drift",
    palette: "ice",
    fillLand: true,
  },
];

/**
 * Palettes offered for the particles: diverging and cyclic ramps carry no
 * meaning for a speed, and black trails vanish on the black background.
 */
export const DEMO_PALETTES: PaletteMeta[] = getPalettes().filter(
  (p) =>
    p.id !== "mono-black" &&
    !p.tags.includes("diverging") &&
    !p.tags.includes("cyclic"),
);
