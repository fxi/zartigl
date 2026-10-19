import {
  catalog,
  requireCatalogEntry,
  resolveLocalizedText,
  type CatalogEntry,
  type CatalogGeoVideoSource,
} from "../catalog";
import {
  geoVideoChunkSources,
  getPalettes,
  isGeoVideoArchiveSource,
  loadGeoVideoIndex,
  type PaletteMeta,
} from "../engine";
import type { ParticleSettings } from "./scales";

/**
 * A catalog entry with a GeoVideo archive, with the styling this projversor
 * renderer gives it: vector entries play as particles, scalar ones as a raster.
 */
export interface ProjversorLayer {
  /** Picker and share key: the entry's first alias, else its id. */
  id: string;
  /** zartigl catalog entry id. */
  entryId: string;
  kind: CatalogEntry["kind"];
  label: string;
  palette: string;
  /** Draw land opaque: off for fields that also cover land. */
  fillLand: boolean;
  /** Overrides of the catalog entry `defaults.particles` (density, speed, fade). */
  particles?: Partial<ParticleSettings>;
  /**
   * Default scalar entry id whose GeoVideo archive colors the particles (over
   * its catalog color domain); speed then sets their brightness. Its monthly
   * chunks pair with the vector ones by calendar period.
   */
  tint?: string;
}

type LayerStyle = Partial<Omit<ProjversorLayer, "entryId" | "kind">>;

/**
 * Particle palettes start dark so the bright trails read against the black
 * background. Keyed by entry alias.
 */
const STYLES: Record<string, LayerStyle> = {
  "surface-wind": {},
  "wave-stokes-drift": { palette: "viridis" },
  "primary-swell-propagation": { palette: "thermal" },
  "sea-ice-drift": { palette: "ice" },
  "med-wave-stokes-drift": { palette: "viridis" },
  "med-primary-swell-propagation": { palette: "thermal" },
};

/** Vector layers repeated with a default tint, after their plain layer. */
const TINTED: Record<string, LayerStyle[]> = {
  "ocean-current-velocity": [
    {
      id: "ocean-velocity-temperature",
      label: "Currents × Temperature",
      // Starts bright: cold, slow water stays visible once dimmed by speed.
      palette: "thermal-alt",
      tint: "3db0120b-17d2-4789-9952-efcc0953ecc4", // sea-water-temperature
    },
  ],
  "med-ocean-current-velocity": [
    {
      id: "med-currents-temperature",
      label: "Mediterranean Currents × Temperature",
      palette: "thermal-alt",
      tint: "f0812aa5-f9b6-4149-ab51-3de9d9d100c3", // med-sea-water-temperature
    },
  ],
};

/** Particle palette of vector entries without a style. */
const PARTICLE_PALETTE = "plasma";

/**
 * Palettes offered for the particles: diverging and cyclic ramps carry no
 * meaning for a speed, and black trails vanish on the black background.
 */
export const PARTICLE_PALETTES: PaletteMeta[] = getPalettes().filter(
  (p) =>
    p.id !== "mono-black" &&
    !p.tags.includes("diverging") &&
    !p.tags.includes("cyclic"),
);

/** Palettes offered for a scalar raster: any but black. */
export const RASTER_PALETTES: PaletteMeta[] = getPalettes().filter(
  (p) => p.id !== "mono-black",
);

export function layerPalettes(layer: ProjversorLayer): PaletteMeta[] {
  return layer.kind === "vector" ? PARTICLE_PALETTES : RASTER_PALETTES;
}

/** Every catalog entry with a GeoVideo archive, vector layers first. */
export function catalogLayers(
  entries: readonly CatalogEntry[] = catalog.layers,
): ProjversorLayer[] {
  const layers: ProjversorLayer[] = [];
  for (const entry of entries) {
    if (!entry.sources.some(isGeoVideoArchiveSource)) {
      continue;
    }
    const id = entry.aliases?.[0] ?? entry.id;
    const base: ProjversorLayer = {
      id,
      entryId: entry.id,
      kind: entry.kind,
      label: resolveLocalizedText(entry.title, "en"),
      palette:
        entry.kind === "vector"
          ? PARTICLE_PALETTE
          : (entry.defaults.palette ?? "viridis"),
      fillLand: true,
      ...STYLES[id],
    };
    layers.push(base);
    for (const tinted of TINTED[id] ?? []) {
      layers.push({ ...base, ...tinted });
    }
  }
  return layers.sort(
    (a, b) => Number(a.kind === "scalar") - Number(b.kind === "scalar"),
  );
}

export const PROJVERSOR_LAYERS: ProjversorLayer[] = catalogLayers();

/** Scalar layers offered to color the particles. */
export const TINT_LAYERS: ProjversorLayer[] = PROJVERSOR_LAYERS.filter(
  (l) => l.kind === "scalar",
);

/** Layer of a share key: a layer id, or the entry id older links carry. */
export function findLayer(
  key: string | undefined,
  layers: readonly ProjversorLayer[] = PROJVERSOR_LAYERS,
): ProjversorLayer | undefined {
  return (
    layers.find((l) => l.id === key) ?? layers.find((l) => l.entryId === key)
  );
}

/** Month chunks of an entry's GeoVideo archive. */
export async function loadChunks(
  entryId: string,
  loadIndex = loadGeoVideoIndex,
): Promise<CatalogGeoVideoSource[]> {
  const entry = requireCatalogEntry(entryId);
  const source = entry.sources.find(isGeoVideoArchiveSource);
  if (!source) {
    throw new Error(`No GeoVideo archive for ${entry.id}`);
  }
  return geoVideoChunkSources(source, await loadIndex(source.indexUrl), entry);
}

/**
 * Month chunks of a tint archive; empty without a tint or when its index
 * cannot be read, so the layer still opens, colored by speed.
 */
export async function loadTintChunks(
  entryId: string | null | undefined,
  loadIndex = loadGeoVideoIndex,
): Promise<CatalogGeoVideoSource[]> {
  if (!entryId) {
    return [];
  }
  try {
    return await loadChunks(entryId, loadIndex);
  } catch (error) {
    console.error(error);
    return [];
  }
}
