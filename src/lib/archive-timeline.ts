import type { CatalogSource } from "../catalog/types";

/** Sample range of a fixed-period chunk; the end defaults to the start. */
function chunkSpan(chunk: CatalogSource): [number, number] {
  const { start, end } = chunk.temporal ?? {};
  return [Date.parse(start ?? ""), Date.parse(end ?? start ?? "")];
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
  const [rangeStart, rangeEnd] = options.range ?? [-Infinity, Infinity];
  const sorted = chunks
    .filter((chunk) => chunk.id === current.id && chunk.temporal?.start != null)
    .map((source) => {
      const [start, end] = chunkSpan(source);
      return { source, start, end };
    })
    .sort((a, b) => a.start - b.start);
  const currentEnd = Date.parse(current.temporal?.end ?? "");
  const next =
    sorted.find(
      (chunk) => chunk.start > currentEnd && chunk.start <= rangeEnd,
    ) ??
    (options.loop
      ? sorted.find(
          (chunk) => chunk.end >= rangeStart && chunk.start <= rangeEnd,
        )
      : undefined);
  return next
    ? { source: next.source, time: Math.max(next.start, rangeStart) }
    : null;
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
  const [start, end] = chunkSpan(chunk);
  let best: T | null = null;
  let bestOverlap = -Infinity;
  for (const candidate of candidates) {
    const [s, e] = chunkSpan(candidate);
    const overlap = Math.min(end, e) - Math.max(start, s);
    if (Number.isFinite(overlap) && overlap >= 0 && overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return best;
}
