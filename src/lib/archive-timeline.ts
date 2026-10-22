import type { CatalogSource } from "../catalog/types";
import {
  nextChunkSpan,
  pairChunkSpan,
  type GeoVideoChunkSpan,
} from "./GeoVideoArchiveSource";

/**
 * Catalog adapters of the neutral archive timeline helpers
 * (nextChunkSpan, pairChunkSpan) for fixed-period catalog sources.
 */

/** Sample range of a fixed-period chunk; the end defaults to the start. */
function chunkSpan<T extends CatalogSource>(
  source: T,
): GeoVideoChunkSpan & { source: T } {
  const { start, end } = source.temporal ?? {};
  return {
    source,
    start: Date.parse(start ?? ""),
    end: Date.parse(end ?? start ?? ""),
  };
}

/**
 * The chunk of `current`'s archive that follows it inside `range`, or with
 * `loop`, the first one inside it, with the time playback resumes at.
 */
export function nextChunk<T extends CatalogSource>(
  chunks: readonly T[],
  current: CatalogSource,
  options: { range?: readonly [number, number] | null; loop?: boolean } = {},
): { source: T; time: number } | null {
  const spans = chunks
    .filter((chunk) => chunk.id === current.id && chunk.temporal?.start != null)
    .map(chunkSpan);
  const next = nextChunkSpan(
    spans,
    Date.parse(current.temporal?.end ?? ""),
    options,
  );
  return next ? { source: next.chunk.source, time: next.time } : null;
}

/**
 * The candidate whose sample range overlaps `chunk` the most: archives
 * sampled at different hours (six-hourly from 00:00, daily at 12:00) still
 * pair by calendar period. Null when none overlaps.
 */
export function pairChunk<T extends CatalogSource>(
  chunk: CatalogSource,
  candidates: readonly T[],
): T | null {
  return (
    pairChunkSpan(chunkSpan(chunk), candidates.map(chunkSpan))?.source ?? null
  );
}
