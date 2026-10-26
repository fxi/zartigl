/**
 * Time windows shared by zartigl and the renderers built on its engine: a
 * fixed `start`/`end`, either side open, or the `trailing` ISO 8601 duration
 * before the latest available time.
 */
export type TimeRange =
  | {
      start?: Date | string | number;
      end?: Date | string | number;
      trailing?: never;
    }
  | { trailing: string; start?: never; end?: never };

const DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function timeToMs(time: Date | string | number): number {
  return time instanceof Date
    ? time.getTime()
    : typeof time === "number"
      ? time
      : new Date(time).getTime();
}

export function parseTime(time: Date | string | number, label: string): number {
  const value = timeToMs(time);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

/** `anchor` minus an ISO 8601 duration, calendar months and years in UTC. */
export function subtractIsoDuration(anchor: number, duration: string): number {
  const match = duration.match(DURATION);
  if (!match) {
    throw new Error(`Invalid trailing time duration: ${duration}`);
  }
  const values = match.slice(1).map((value) => Number(value ?? 0));
  if (!values.some((value) => value > 0)) {
    throw new Error("Trailing time duration must be positive");
  }
  const [years, months, weeks, days, hours, minutes, seconds] = values;
  const source = new Date(anchor);
  const monthIndex =
    source.getUTCFullYear() * 12 + source.getUTCMonth() - years * 12 - months;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
  return (
    result -
    (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60_000 -
    seconds * 1000
  );
}

/**
 * Bounds of `range` inside the available `[min, max]`, epoch ms: open sides
 * take the available ones, `trailing` counts back from `max`.
 */
export function timeRangeBounds(
  range: TimeRange,
  [sourceMin, sourceMax]: readonly [number, number],
): [number, number] {
  let min = sourceMin;
  let max = sourceMax;
  if (typeof range.trailing === "string") {
    min = subtractIsoDuration(sourceMax, range.trailing);
  } else {
    if (range.start != null) {
      min = parseTime(range.start, "time range start");
    }
    if (range.end != null) {
      max = parseTime(range.end, "time range end");
    }
  }
  if (min > max) {
    throw new Error("Time range start must not follow its end");
  }
  return [Math.max(sourceMin, min), Math.min(sourceMax, max)];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validate a time range from a JSON config: `{ start?, end? }` as ISO dates
 * with start before end, or `{ trailing }` as a positive ISO 8601 duration.
 */
export function parseTimeRange(value: unknown, path: string): TimeRange {
  if (!isObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "start" && key !== "end" && key !== "trailing") {
      throw new Error(`${path}.${key} is not a time range key`);
    }
  }
  if (value.trailing !== undefined) {
    if (value.start !== undefined || value.end !== undefined) {
      throw new Error(`${path}.trailing excludes start and end`);
    }
    if (typeof value.trailing !== "string") {
      throw new Error(`${path}.trailing must be an ISO 8601 duration`);
    }
    subtractIsoDuration(0, value.trailing);
    return { trailing: value.trailing };
  }
  const bound = (key: "start" | "end"): string | undefined => {
    const time = value[key];
    if (time === undefined) {
      return undefined;
    }
    if (typeof time !== "string" || !Number.isFinite(Date.parse(time))) {
      throw new Error(`${path}.${key} is not a date`);
    }
    return time;
  };
  const start = bound("start");
  const end = bound("end");
  if (
    start !== undefined &&
    end !== undefined &&
    Date.parse(start) > Date.parse(end)
  ) {
    throw new Error(`${path}.start must not follow its end`);
  }
  return {
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
  };
}
