import type {
  CatalogEntry,
  CatalogGeoVideoArchiveSource,
  CatalogGeoVideoSource,
  CatalogSource,
} from "../catalog/types";
import type { GeoVideoArchiveChunk } from "./GeoVideoArchiveSource";

/** One immutable, calendar-aligned artifact of a GeoVideo archive. */
export interface GeoVideoIndexChunk {
  period: { start: string; end: string };
  /** First and last encoded sample. */
  start: string;
  end: string;
  samples: number;
  /** Every encoded sample; absent from chunks indexed before it existed. */
  times?: string[];
  key: string;
  /** Relative to the index URL. */
  manifestUrl: string;
  provisional?: boolean;
}

/** A native vertical level: the store coordinate's identity and exact value. */
export interface GeoVideoVerticalLevel {
  name: string;
  units: string;
  /** CF `positive`: "up" for elevation, "down" for depth. */
  positive: string;
  value: number;
}

/** A level besides the surface, with the index of its own chunks. */
export interface GeoVideoIndexDepth extends GeoVideoVerticalLevel {
  /** Relative to the surface index URL. */
  indexUrl: string;
}

/** Mutable listing of an archive's published chunks, written by the renderer. */
export interface GeoVideoIndex {
  schemaVersion: 1;
  type: "geovideo-index";
  catalogEntryId: string;
  sourceId: string;
  updatedAt: string | null;
  chunks: GeoVideoIndexChunk[];
  /** On a surface index: the levels below it with playable chunks, shallow to deep. */
  depths?: GeoVideoIndexDepth[];
  /** On a surface index with depths: the surface level. */
  surface?: GeoVideoVerticalLevel;
  /** On a depth index: its level. */
  vertical?: GeoVideoVerticalLevel;
}

/** Same coordinate and value. */
export function sameVerticalLevel(
  a: GeoVideoVerticalLevel | undefined,
  b: GeoVideoVerticalLevel | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.name === b.name &&
    a.units === b.units &&
    a.positive === b.positive &&
    a.value === b.value
  );
}

function isVerticalLevel(value: unknown): value is GeoVideoVerticalLevel {
  const level = value as GeoVideoVerticalLevel;
  return (
    !!level &&
    typeof level.name === "string" &&
    typeof level.units === "string" &&
    typeof level.positive === "string" &&
    Number.isFinite(level.value)
  );
}

/** Levels of one coordinate, each once, the surface not among the depths. */
function validDepths(index: GeoVideoIndex): boolean {
  const depths = index.depths;
  if (depths === undefined) {
    return index.surface === undefined || isVerticalLevel(index.surface);
  }
  // A surface level is recorded with the depths; tolerated without it.
  const surface = index.surface ?? depths?.[0];
  if (!Array.isArray(depths) || !isVerticalLevel(surface)) {
    return depths?.length === 0;
  }
  const values = new Set<number>(index.surface ? [surface.value] : []);
  return depths.every((depth) => {
    const valid =
      isVerticalLevel(depth) &&
      typeof depth.indexUrl === "string" &&
      depth.name === surface.name &&
      depth.units === surface.units &&
      depth.positive === surface.positive &&
      !values.has(depth.value);
    values.add(depth.value);
    return valid;
  });
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

/** Sample times that agree with the chunk's count and bounds, in order. */
function validTimes(chunk: GeoVideoIndexChunk): boolean {
  const times = chunk.times;
  if (
    !Array.isArray(times) ||
    times.length !== chunk.samples ||
    times[0] !== chunk.start ||
    times[times.length - 1] !== chunk.end
  ) {
    return false;
  }
  let previous = -Infinity;
  for (const time of times) {
    const ms = isoDate(time) ? Date.parse(time) : NaN;
    if (!(ms > previous)) {
      return false;
    }
    previous = ms;
  }
  return true;
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
  if (
    !validDepths(index) ||
    (index.vertical !== undefined && !isVerticalLevel(index.vertical))
  ) {
    throw new Error("Invalid GeoVideo index levels");
  }
  for (const chunk of index.chunks) {
    if (
      !isoDate(chunk?.start) ||
      !isoDate(chunk.end) ||
      Date.parse(chunk.end) < Date.parse(chunk.start) ||
      typeof chunk.manifestUrl !== "string" ||
      (chunk.times !== undefined && !validTimes(chunk))
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

/** An index URL resolved like the browser resolves it. */
function absoluteUrl(url: string): string {
  return typeof document !== "undefined"
    ? new URL(url, document.baseURI).href
    : url;
}

/**
 * Catalog-free chunk descriptors of an index, manifest URLs resolved
 * against the index URL, in index order.
 */
export function geoVideoIndexChunks(
  index: GeoVideoIndex,
  indexUrl: string,
): GeoVideoArchiveChunk[] {
  const base = absoluteUrl(indexUrl);
  return index.chunks.map((chunk) => ({
    key: chunk.key,
    manifestUrl: new URL(chunk.manifestUrl, base).href,
    start: Date.parse(chunk.start),
    end: Date.parse(chunk.end),
    samples: chunk.samples,
    ...(chunk.times ? { times: chunk.times.map(Date.parse) } : {}),
    ...(chunk.provisional ? { provisional: true } : {}),
  }));
}

/** Throws unless the index was written for this catalog entry and source. */
export function assertGeoVideoIndexIdentity(
  source: CatalogGeoVideoArchiveSource,
  index: GeoVideoIndex,
  entry: CatalogEntry,
): void {
  if (index.sourceId !== source.id || index.catalogEntryId !== entry.id) {
    throw new Error(
      `GeoVideo index identity does not match catalog entry/source: ${source.id}`,
    );
  }
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
  assertGeoVideoIndexIdentity(source, index, entry);
  const chunks = geoVideoIndexChunks(index, source.indexUrl);
  return index.chunks.map(
    (chunk, i): CatalogGeoVideoSource => ({
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
      manifestUrl: chunks[i].manifestUrl,
    }),
  );
}

/** Absolute URL of a depth's index, listed relative to the surface index. */
export function depthIndexUrl(
  depth: GeoVideoIndexDepth,
  surfaceIndexUrl: string,
): string {
  return new URL(depth.indexUrl, absoluteUrl(surfaceIndexUrl)).href;
}
