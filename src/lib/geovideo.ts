export type GeoVideoBounds = [west: number, south: number, east: number, north: number];

export interface GeoVideoRangeTimeline {
  kind: "range";
  dateStart: string;
  dateEnd: string;
  interpolation: "linear" | "nearest";
}

export interface GeoVideoSnapshotLoopTimeline {
  kind: "snapshot-loop";
  date: string;
}

export interface GeoVideoSampleSequenceTimeline {
  kind: "sample-sequence";
  values: string[];
}

export interface GeoVideoManifest {
  schemaVersion: 3;
  id: string;
  type: "geovideo";
  projection: "equirectangular";
  bounds: GeoVideoBounds;
  media: {
    url: string;
    mimeType: "video/mp4" | string;
    width: number;
    height: number;
    fps: number;
    durationSeconds: number;
    codec: "h264" | string;
  };
  encoding: {
    kind: "scalar-luma";
    bits: 8;
    codeMin: number;
    codeMax: number;
    valueMin: number;
    valueMax: number;
    transfer: "linear";
    colorSpace: "bt709";
    colorRange: "limited" | "full";
  };
  mask: {
    kind: "static-validity";
    url: string;
    mimeType: "image/png" | string;
    width: number;
    height: number;
    threshold: number;
  };
  timeline: GeoVideoRangeTimeline | GeoVideoSnapshotLoopTimeline | GeoVideoSampleSequenceTimeline;
  provenance: {
    catalogEntryId: string;
    inputSourceId: string;
    provider?: string;
    identifiers?: Record<string, string>;
    variables: string[];
    generatedAt: string;
  };
  style: {
    palette: string;
    colorDomain: [number, number];
    unit?: string;
    logScale?: boolean;
    vibrance?: number;
  };
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid GeoVideo manifest ${label}`);
  }
  return value;
}

function dateMs(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`Invalid GeoVideo manifest ${label}`);
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid GeoVideo manifest ${label}`);
  return ms;
}

function uuid4(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function validateGeoVideoManifest(value: unknown): GeoVideoManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid GeoVideo manifest");
  const manifest = value as GeoVideoManifest;
  if (manifest.schemaVersion !== 3 || manifest.type !== "geovideo") {
    throw new Error("Unsupported GeoVideo manifest version or type");
  }
  if (manifest.projection !== "equirectangular") {
    throw new Error(`Unsupported GeoVideo projection: ${String(manifest.projection)}`);
  }
  if (!Array.isArray(manifest.bounds) || manifest.bounds.length !== 4) {
    throw new Error("Invalid GeoVideo manifest bounds");
  }
  const [west, south, east, north] = manifest.bounds.map((v, i) => finite(v, `bounds[${i}]`));
  if (south < -90 || north > 90 || south >= north || west === east) {
    throw new Error("Invalid GeoVideo geographic bounds");
  }
  const media = manifest.media;
  if (!media || typeof media.url !== "string" || !media.url) {
    throw new Error("Invalid GeoVideo media");
  }
  for (const key of ["width", "height", "fps", "durationSeconds"] as const) {
    if (finite(media[key], `media.${key}`) <= 0) throw new Error(`Invalid GeoVideo media.${key}`);
  }
  const encoding = manifest.encoding;
  if (
    !encoding || encoding.kind !== "scalar-luma" || encoding.bits !== 8 ||
    encoding.transfer !== "linear" || encoding.colorSpace !== "bt709" ||
    (encoding.colorRange !== "limited" && encoding.colorRange !== "full")
  ) throw new Error("Invalid GeoVideo scalar-luma encoding");
  const codeMin = finite(encoding.codeMin, "encoding.codeMin");
  const codeMax = finite(encoding.codeMax, "encoding.codeMax");
  const valueMin = finite(encoding.valueMin, "encoding.valueMin");
  const valueMax = finite(encoding.valueMax, "encoding.valueMax");
  if (codeMin < 0 || codeMax > 255 || codeMin >= codeMax || valueMin >= valueMax) {
    throw new Error("Invalid GeoVideo scalar-luma ranges");
  }
  const mask = manifest.mask;
  if (
    !mask || mask.kind !== "static-validity" || typeof mask.url !== "string" || !mask.url ||
    finite(mask.width, "mask.width") !== media.width ||
    finite(mask.height, "mask.height") !== media.height ||
    finite(mask.threshold, "mask.threshold") < 0 || mask.threshold > 1
  ) throw new Error("Invalid GeoVideo static mask");
  if (manifest.timeline?.kind === "range") {
    const start = dateMs(manifest.timeline.dateStart, "timeline.dateStart");
    const end = dateMs(manifest.timeline.dateEnd, "timeline.dateEnd");
    if (end <= start) throw new Error("GeoVideo timeline end must follow start");
    if (manifest.timeline.interpolation !== "linear" && manifest.timeline.interpolation !== "nearest") {
      throw new Error("Invalid GeoVideo interpolation");
    }
  } else if (manifest.timeline?.kind === "snapshot-loop") {
    dateMs(manifest.timeline.date, "timeline.date");
  } else if (manifest.timeline?.kind === "sample-sequence") {
    if (!Array.isArray(manifest.timeline.values) || manifest.timeline.values.length === 0) {
      throw new Error("GeoVideo sample sequence must contain values");
    }
    const values = manifest.timeline.values.map((value, index) => dateMs(value, `timeline.values[${index}]`));
    if (values.some((value, index) => index > 0 && value <= values[index - 1])) {
      throw new Error("GeoVideo sample sequence values must be strictly increasing");
    }
  } else {
    throw new Error("Invalid GeoVideo timeline");
  }
  const domain = manifest.style?.colorDomain;
  if (!Array.isArray(domain) || domain.length !== 2 || !domain.every(Number.isFinite) || domain[0] >= domain[1]) {
    throw new Error("Invalid GeoVideo color domain");
  }
  if (!uuid4(manifest.id) || !manifest.provenance || !uuid4(manifest.provenance.catalogEntryId) ||
      !uuid4(manifest.provenance.inputSourceId) || !Array.isArray(manifest.provenance.variables) ||
      manifest.provenance.variables.length === 0) throw new Error("Invalid GeoVideo provenance");
  return { ...manifest, bounds: [west, south, east, north] };
}

export async function loadGeoVideoManifest(
  source: string | GeoVideoManifest,
  signal?: AbortSignal,
): Promise<GeoVideoManifest> {
  if (typeof source !== "string") return validateGeoVideoManifest(source);
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error(`GeoVideo manifest request failed (${response.status}): ${source}`);
  const raw = await response.json();
  const manifest = validateGeoVideoManifest(raw);
  const base = typeof document !== "undefined" ? new URL(source, document.baseURI).href : source;
  return {
    ...manifest,
    media: { ...manifest.media, url: new URL(manifest.media.url, base).href },
    mask: { ...manifest.mask, url: new URL(manifest.mask.url, base).href },
  };
}

export function geoVideoTimelineValues(manifest: GeoVideoManifest): number[] {
  if (manifest.timeline.kind === "snapshot-loop") {
    return [new Date(manifest.timeline.date).getTime()];
  }
  if (manifest.timeline.kind === "sample-sequence") {
    return manifest.timeline.values.map((value) => new Date(value).getTime());
  }
  const start = new Date(manifest.timeline.dateStart).getTime();
  const end = new Date(manifest.timeline.dateEnd).getTime();
  const count = Math.max(2, Math.round(manifest.media.durationSeconds * manifest.media.fps));
  return Array.from({ length: count }, (_, index) => start + (end - start) * index / (count - 1));
}

export function geoVideoSecondsForTime(manifest: GeoVideoManifest, timeMs: number): number {
  if (manifest.timeline.kind === "snapshot-loop") return 0;
  if (manifest.timeline.kind === "sample-sequence") {
    const values = geoVideoTimelineValues(manifest);
    let nearest = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (Math.abs(values[index] - timeMs) < Math.abs(values[nearest] - timeMs)) nearest = index;
    }
    const segment = manifest.media.durationSeconds / values.length;
    return nearest * segment + Math.min(segment / 2, 0.5 / manifest.media.fps);
  }
  const start = new Date(manifest.timeline.dateStart).getTime();
  const end = new Date(manifest.timeline.dateEnd).getTime();
  const progress = Math.max(0, Math.min(1, (timeMs - start) / (end - start)));
  return progress * playableDuration(manifest);
}

export function geoVideoTimeForSeconds(manifest: GeoVideoManifest, seconds: number): number {
  if (manifest.timeline.kind === "snapshot-loop") return new Date(manifest.timeline.date).getTime();
  if (manifest.timeline.kind === "sample-sequence") {
    const values = geoVideoTimelineValues(manifest);
    const progress = manifest.media.durationSeconds > 0
      ? Math.max(0, Math.min(1 - Number.EPSILON, seconds / manifest.media.durationSeconds))
      : 0;
    return values[Math.min(values.length - 1, Math.floor(progress * values.length))];
  }
  const start = new Date(manifest.timeline.dateStart).getTime();
  const end = new Date(manifest.timeline.dateEnd).getTime();
  const duration = playableDuration(manifest);
  const progress = duration > 0 ? Math.max(0, Math.min(1, seconds / duration)) : 0;
  return start + (end - start) * progress;
}

function playableDuration(manifest: GeoVideoManifest): number {
  return Math.max(0, manifest.media.durationSeconds - 1 / manifest.media.fps);
}
