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

export interface GeoVideoManifestV1 {
  schemaVersion: 1;
  id: string;
  type: "geovideo";
  projection: "equirectangular";
  bounds: GeoVideoBounds;
  media: {
    url: string;
    mimeType: "video/mp4" | string;
    width: number;
    height: number;
    packedWidth: number;
    packedHeight: number;
    fps: number;
    durationSeconds: number;
    codec: "h264" | string;
    alpha: "side-by-side";
  };
  timeline: GeoVideoRangeTimeline | GeoVideoSnapshotLoopTimeline;
  provenance: {
    layerId: string;
    datasetId: string;
    variable: string;
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

export function validateGeoVideoManifest(value: unknown): GeoVideoManifestV1 {
  if (!value || typeof value !== "object") throw new Error("Invalid GeoVideo manifest");
  const manifest = value as GeoVideoManifestV1;
  if (manifest.schemaVersion !== 1 || manifest.type !== "geovideo") {
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
  if (!media || typeof media.url !== "string" || !media.url || media.alpha !== "side-by-side") {
    throw new Error("Invalid GeoVideo media");
  }
  for (const key of ["width", "height", "packedWidth", "packedHeight", "fps", "durationSeconds"] as const) {
    if (finite(media[key], `media.${key}`) <= 0) throw new Error(`Invalid GeoVideo media.${key}`);
  }
  if (media.packedWidth !== media.width * 2 || media.packedHeight !== media.height) {
    throw new Error("GeoVideo side-by-side media dimensions are inconsistent");
  }
  if (manifest.timeline?.kind === "range") {
    const start = dateMs(manifest.timeline.dateStart, "timeline.dateStart");
    const end = dateMs(manifest.timeline.dateEnd, "timeline.dateEnd");
    if (end <= start) throw new Error("GeoVideo timeline end must follow start");
    if (manifest.timeline.interpolation !== "linear" && manifest.timeline.interpolation !== "nearest") {
      throw new Error("Invalid GeoVideo interpolation");
    }
  } else if (manifest.timeline?.kind === "snapshot-loop") {
    dateMs(manifest.timeline.date, "timeline.date");
  } else {
    throw new Error("Invalid GeoVideo timeline");
  }
  const domain = manifest.style?.colorDomain;
  if (!Array.isArray(domain) || domain.length !== 2 || !domain.every(Number.isFinite) || domain[0] >= domain[1]) {
    throw new Error("Invalid GeoVideo color domain");
  }
  return { ...manifest, bounds: [west, south, east, north] };
}

export async function loadGeoVideoManifest(
  source: string | GeoVideoManifestV1,
  signal?: AbortSignal,
): Promise<GeoVideoManifestV1> {
  if (typeof source !== "string") return validateGeoVideoManifest(source);
  const response = await fetch(source, { signal });
  if (!response.ok) throw new Error(`GeoVideo manifest request failed (${response.status}): ${source}`);
  const raw = await response.json();
  const manifest = validateGeoVideoManifest(raw);
  const base = typeof document !== "undefined" ? new URL(source, document.baseURI).href : source;
  return {
    ...manifest,
    media: {
      ...manifest.media,
      url: new URL(manifest.media.url, base).href,
    },
  };
}

export function geoVideoTimelineValues(manifest: GeoVideoManifestV1): number[] {
  if (manifest.timeline.kind === "snapshot-loop") {
    return [new Date(manifest.timeline.date).getTime()];
  }
  const start = new Date(manifest.timeline.dateStart).getTime();
  const end = new Date(manifest.timeline.dateEnd).getTime();
  const count = Math.max(2, Math.round(manifest.media.durationSeconds * manifest.media.fps));
  return Array.from({ length: count }, (_, index) => start + (end - start) * index / (count - 1));
}

export function geoVideoSecondsForTime(manifest: GeoVideoManifestV1, timeMs: number): number {
  if (manifest.timeline.kind === "snapshot-loop") return 0;
  const start = new Date(manifest.timeline.dateStart).getTime();
  const end = new Date(manifest.timeline.dateEnd).getTime();
  const progress = Math.max(0, Math.min(1, (timeMs - start) / (end - start)));
  return progress * playableDuration(manifest);
}

export function geoVideoTimeForSeconds(manifest: GeoVideoManifestV1, seconds: number): number {
  if (manifest.timeline.kind === "snapshot-loop") return new Date(manifest.timeline.date).getTime();
  const start = new Date(manifest.timeline.dateStart).getTime();
  const end = new Date(manifest.timeline.dateEnd).getTime();
  const duration = playableDuration(manifest);
  const progress = duration > 0 ? Math.max(0, Math.min(1, seconds / duration)) : 0;
  return start + (end - start) * progress;
}

function playableDuration(manifest: GeoVideoManifestV1): number {
  return Math.max(0, manifest.media.durationSeconds - 1 / manifest.media.fps);
}
