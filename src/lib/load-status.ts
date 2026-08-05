export type ZartiglStatus =
  | { phase: "metadata" }
  | { phase: "fetching"; time: number; completed: number; total: number }
  | { phase: "rendering"; time: number }
  | { phase: "ready"; time: number }
  | { phase: "blocked"; time: number; statuses: number[]; message: string }
  | { phase: "error"; time?: number; error: Error };

export class ZartiglFrameUnavailableError extends Error {
  readonly time: number;
  readonly statuses: number[];
  readonly urls: string[];

  constructor(time: number, statuses: number[], urls: string[]) {
    super(
      statuses.length > 0
        ? "Remote data is not available yet; the selected frame may still be publishing."
        : "The selected frame contains no renderable data.",
    );
    this.name = "ZartiglFrameUnavailableError";
    this.time = time;
    this.statuses = [...new Set(statuses)].sort((a, b) => a - b);
    this.urls = [...new Set(urls)];
  }
}

export function hasRenderableScalar(values: Float32Array): boolean {
  for (const value of values) {
    if (Number.isFinite(value)) return true;
  }
  return false;
}

export function hasRenderableVector(u: Float32Array, v: Float32Array): boolean {
  for (let index = 0; index < Math.min(u.length, v.length); index++) {
    if (Number.isFinite(u[index]) && Number.isFinite(v[index])) return true;
  }
  return false;
}

export function blockedStatus(error: ZartiglFrameUnavailableError): ZartiglStatus {
  return {
    phase: "blocked",
    time: error.time,
    statuses: error.statuses,
    message: error.message,
  };
}
