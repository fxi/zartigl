import type {
  CatalogEntry,
  CatalogGeoVideoArchiveSource,
  CatalogGeoVideoSource,
  CatalogSource,
} from "../catalog/types";

/** One immutable, calendar-aligned artifact of a GeoVideo archive. */
export interface GeoVideoIndexChunk {
  period: { start: string; end: string };
  /** First and last encoded sample. */
  start: string;
  end: string;
  samples: number;
  key: string;
  /** Relative to the index URL. */
  manifestUrl: string;
  provisional?: boolean;
}

/** Mutable listing of an archive's published chunks, written by the renderer. */
export interface GeoVideoIndex {
  schemaVersion: 1;
  type: "geovideo-index";
  catalogEntryId: string;
  sourceId: string;
  updatedAt: string | null;
  chunks: GeoVideoIndexChunk[];
}

export function isGeoVideoArchiveSource(
  source: CatalogSource,
): source is CatalogGeoVideoArchiveSource {
  return source.type === "geovideo" && typeof source.indexUrl === "string";
}

/** Same render source; archive chunks share their archive's id. */
export function isSameSource(a: CatalogSource, b: CatalogSource): boolean {
  return (
    a.id === b.id &&
    (a.type !== "geovideo" ||
      b.type !== "geovideo" ||
      a.manifestUrl === b.manifestUrl)
  );
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateGeoVideoIndex(value: unknown): GeoVideoIndex {
  const index = value as GeoVideoIndex;
  if (
    !index ||
    index.schemaVersion !== 1 ||
    index.type !== "geovideo-index" ||
    !Array.isArray(index.chunks)
  ) {
    throw new Error("Unsupported GeoVideo index");
  }
  for (const chunk of index.chunks) {
    if (
      !isoDate(chunk?.start) ||
      !isoDate(chunk.end) ||
      Date.parse(chunk.end) < Date.parse(chunk.start) ||
      typeof chunk.manifestUrl !== "string"
    ) {
      throw new Error("Invalid GeoVideo index chunk");
    }
  }
  return index;
}

export async function loadGeoVideoIndex(
  url: string,
  signal?: AbortSignal,
): Promise<GeoVideoIndex> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `GeoVideo index request failed (${response.status}): ${url}`,
    );
  }
  return validateGeoVideoIndex(await response.json());
}

/**
 * Fixed-period GeoVideo sources, one per chunk. They keep the archive source
 * id, which the chunk manifests carry as their identity.
 */
export function geoVideoChunkSources(
  source: CatalogGeoVideoArchiveSource,
  index: GeoVideoIndex,
  entry: CatalogEntry,
): CatalogGeoVideoSource[] {
  if (index.sourceId !== source.id || index.catalogEntryId !== entry.id) {
    throw new Error(
      `GeoVideo index identity does not match catalog entry/source: ${source.id}`,
    );
  }
  const base =
    typeof document !== "undefined"
      ? new URL(source.indexUrl, document.baseURI).href
      : source.indexUrl;
  return index.chunks.map(
    (chunk): CatalogGeoVideoSource => ({
      id: source.id,
      type: "geovideo",
      title: source.title,
      provenance: source.provenance,
      temporal: {
        mode: "fixed",
        cadence: source.temporal?.cadence,
        start: chunk.start,
        end: chunk.end,
      },
      manifestUrl: new URL(chunk.manifestUrl, base).href,
    }),
  );
}
