export interface LimitedTimeRange {
  start?: number;
  end?: number;
}

export type SharedTimeRange = [number, number] | LimitedTimeRange;

export function buildLimitedTimeRange(
  start: number,
  end: number,
  limitStart: boolean,
  limitEnd: boolean,
): LimitedTimeRange | undefined {
  if (!limitStart && !limitEnd) {
    return undefined;
  }
  return {
    ...(limitStart ? { start } : {}),
    ...(limitEnd ? { end } : {}),
  };
}

export function normalizeSharedTimeRange(
  range?: SharedTimeRange,
): LimitedTimeRange | undefined {
  if (Array.isArray(range)) {
    const [start, end] = range;
    return Number.isFinite(start) && Number.isFinite(end)
      ? { start, end }
      : undefined;
  }
  if (!range) {
    return undefined;
  }
  const start = Number.isFinite(range.start) ? range.start : undefined;
  const end = Number.isFinite(range.end) ? range.end : undefined;
  return start === undefined && end === undefined ? undefined : { start, end };
}

export function isoTimeRange(
  range?: LimitedTimeRange,
): { start?: string; end?: string } | undefined {
  if (!range) {
    return undefined;
  }
  return {
    ...(range.start !== undefined
      ? { start: new Date(range.start).toISOString() }
      : {}),
    ...(range.end !== undefined
      ? { end: new Date(range.end).toISOString() }
      : {}),
  };
}

/**
 * Time exported in generated code. Omitted unless the author pins it, so
 * the runtime keeps resolving the latest available step at load time.
 */
export function exportedSnippetTime(
  selected: number,
  pinned: boolean,
): Date | undefined {
  return pinned && Number.isFinite(selected) ? new Date(selected) : undefined;
}
