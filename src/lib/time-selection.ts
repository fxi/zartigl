import type { TimeGranularity } from "./Zartigl";

function periodKey(time: number, granularity: TimeGranularity): string {
  const iso = new Date(time).toISOString();
  if (granularity === "year") return iso.slice(0, 4);
  if (granularity === "month") return iso.slice(0, 7);
  if (granularity === "day") return iso.slice(0, 10);
  return "";
}

function inputTime(value: string, granularity: TimeGranularity): number {
  if (granularity === "year") return Date.UTC(Number(value), 0, 1);
  if (granularity === "month") return new Date(`${value}-01T00:00:00Z`).getTime();
  if (granularity === "day") return new Date(`${value}T00:00:00Z`).getTime();
  return new Date(`${value}Z`).getTime();
}

/** Resolve a native date/time control value against actual available times. */
export function resolveTimeInputSelection(
  values: readonly number[],
  value: string,
  granularity: TimeGranularity,
): number | undefined {
  if (!value || values.length === 0) return undefined;

  if (["year", "month", "day"].includes(granularity)) {
    const inPeriod = values.find((time) => periodKey(time, granularity) === value);
    if (inPeriod !== undefined) return inPeriod;
  }

  const target = inputTime(value, granularity);
  if (!Number.isFinite(target)) return undefined;
  return values.reduce((nearest, time) =>
    Math.abs(time - target) < Math.abs(nearest - target) ? time : nearest
  );
}
