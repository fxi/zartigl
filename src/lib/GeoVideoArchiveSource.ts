import {
  geoVideoTimelineValues,
  loadGeoVideoManifest,
  type GeoVideoBounds,
  type GeoVideoManifest,
} from "./geovideo";
import {
  abortable,
  abortError,
  type GeoVideoFrameRequest,
} from "./GeoVideoFrameSource";
import {
  GeoVideoScalarSource,
  type GeoVideoScalarFrame,
} from "./GeoVideoScalarSource";
import {
  GeoVideoVectorSource,
  type GeoVideoVectorFrame,
} from "./GeoVideoVectorSource";

/** First and last encoded sample of a chunk, UTC milliseconds. */
export interface GeoVideoChunkSpan {
  start: number;
  end: number;
}

/**
 * One immutable chunk of a GeoVideo archive, independent of the catalog: a
 * manifest and the range of its encoded samples.
 */
export interface GeoVideoArchiveChunk extends GeoVideoChunkSpan {
  /** Stable identity of the chunk content (the index chunk key). */
  key: string;
  /** Absolute manifest URL. */
  manifestUrl: string;
  /** Encoded samples, when the index lists them. */
  samples?: number;
  provisional?: boolean;
}

/**
 * The chunk following the one that ends at `currentEnd` inside `range`, or
 * with `loop`, the first one inside it, with the time playback resumes at.
 */
export function nextChunkSpan<T extends GeoVideoChunkSpan>(
  chunks: readonly T[],
  currentEnd: number,
  options: { range?: readonly [number, number] | null; loop?: boolean } = {},
): { chunk: T; time: number } | null {
  const [rangeStart, rangeEnd] = options.range ?? [-Infinity, Infinity];
  const sorted = [...chunks].sort((a, b) => a.start - b.start);
  const next =
    sorted.find(
      (chunk) => chunk.start > currentEnd && chunk.start <= rangeEnd,
    ) ??
    (options.loop
      ? sorted.find(
          (chunk) => chunk.end >= rangeStart && chunk.start <= rangeEnd,
        )
      : undefined);
  return next ? { chunk: next, time: Math.max(next.start, rangeStart) } : null;
}

/**
 * The candidate whose sample range overlaps `span` the most: archives
 * sampled at different hours (six-hourly from 00:00, daily at 12:00) still
 * pair by calendar period. Null when none overlaps.
 */
export function pairChunkSpan<T extends GeoVideoChunkSpan>(
  span: GeoVideoChunkSpan,
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestOverlap = -Infinity;
  for (const candidate of candidates) {
    const overlap =
      Math.min(span.end, candidate.end) - Math.max(span.start, candidate.start);
    if (Number.isFinite(overlap) && overlap >= 0 && overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * Grid of decoded frame values. `bounds` are the outer cell edges
 * [west, south, east, north] in degrees, so cell (column i, row j) is
 * centered at west + (i + 0.5)·dx, north − (j + 0.5)·dy with
 * dx = (east − west) / width and dy = (north − south) / height; an east
 * below west crosses the antimeridian (east + 360). Row 0 is the northern
 * row, values are row-major.
 */
export interface GeoVideoGrid {
  width: number;
  height: number;
  bounds: GeoVideoBounds;
  rowOrder: "north-to-south";
}

export function geoVideoGrid(manifest: GeoVideoManifest): GeoVideoGrid {
  return {
    width: manifest.mask.width,
    height: manifest.mask.height,
    bounds: manifest.bounds,
    rowOrder: "north-to-south",
  };
}

/** A scalar frame image (decoded on the GPU) or u/v components (NaN invalid). */
export type GeoVideoFrameData = GeoVideoScalarFrame | GeoVideoVectorFrame;

/** The part of a frame source an archive reads. */
export interface GeoVideoFrameReader<TFrame> {
  frame(index: number, request?: GeoVideoFrameRequest): Promise<TFrame>;
  release(): void;
}

/** The frame source decoding `manifest`: scalar or vector by its encoding. */
export function createGeoVideoFrameSource(
  manifest: GeoVideoManifest,
  options: { cacheSize?: number } = {},
): GeoVideoScalarSource | GeoVideoVectorSource {
  return manifest.encoding.kind === "vector-luma"
    ? new GeoVideoVectorSource(manifest, options)
    : new GeoVideoScalarSource(manifest, options);
}

/** One decoded time step of an archive. */
export interface GeoVideoArchiveFrame<TFrame = GeoVideoFrameData> {
  /** Stable identity: archive id, chunk key and step. */
  key: string;
  chunk: GeoVideoArchiveChunk;
  /** Step within the chunk. */
  step: number;
  time: number;
  data: TFrame;
  grid: GeoVideoGrid;
  manifest: GeoVideoManifest;
}

/**
 * The frames bracketing a time, possibly from two chunks: display
 * a·(1 − mix) + b·mix. `b` is `a` with mix 0 in discrete mode or on a step.
 */
export interface GeoVideoArchiveSample<TFrame = GeoVideoFrameData> {
  time: number;
  a: GeoVideoArchiveFrame<TFrame>;
  b: GeoVideoArchiveFrame<TFrame>;
  mix: number;
}

/** Interpolate between bracketing steps, or hold the last step at or before. */
export type GeoVideoSampleMode = "interpolate" | "discrete";

export interface GeoVideoArchiveSourceOptions<TFrame> {
  /** Archive identity, the prefix of every frame key. */
  id: string;
  chunks: readonly GeoVideoArchiveChunk[];
  /** Chunk sources kept open (decoder, video element); at least 2. */
  maxOpenChunks?: number;
  /** Decoded frames cached per chunk source. */
  frameCacheSize?: number;
  /**
   * Progress through a chunk past which the next chunk is opened and its
   * first frame decoded; above 1 disables prefetching.
   */
  prefetchAt?: number;
  /**
   * Longest gap bridged between the last step of a chunk and the first of
   * the next one, in ms. By default 1.5 times the largest step interval at
   * that boundary, and no bridge when both neighbouring chunks hold a
   * single step (no cadence known). Unbridged gaps are out of coverage.
   */
  maxGap?: number;
  loadManifest?: (url: string) => Promise<GeoVideoManifest>;
  createFrameSource?: (
    manifest: GeoVideoManifest,
    options: { cacheSize: number },
  ) => GeoVideoFrameReader<TFrame>;
}

/** Defaults: current, next and previous chunk; the historical 0.6 prefetch. */
const MAX_OPEN_CHUNKS = 3;
const FRAME_CACHE_SIZE = 3;
const PREFETCH_AT = 0.6;
const GAP_TOLERANCE = 1.5;

interface OpenChunk<TFrame> {
  chunk: GeoVideoArchiveChunk;
  ready: Promise<OpenedChunk<TFrame>>;
  opened: OpenedChunk<TFrame> | null;
  /** Running samples using the chunk; it is not evicted meanwhile. */
  users: number;
  prefetch: AbortController | null;
  released: boolean;
}

interface OpenedChunk<TFrame> {
  manifest: GeoVideoManifest;
  times: Float64Array;
  grid: GeoVideoGrid;
  source: GeoVideoFrameReader<TFrame>;
}

/** Step at or before `time` (clamped) and the fraction toward the next. */
function bracket(
  times: Float64Array,
  time: number,
): { step: number; fraction: number } {
  const last = times.length - 1;
  if (time <= times[0]) {
    return { step: 0, fraction: 0 };
  }
  if (time >= times[last]) {
    return { step: last, fraction: 0 };
  }
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { step: lo, fraction: (time - times[lo]) / (times[hi] - times[lo]) };
}

/** A controller aborted with `signal`, which can also be aborted alone. */
function linkedController(signal: AbortSignal | undefined): {
  controller: AbortController;
  unlink: () => void;
} {
  const controller = new AbortController();
  if (!signal) {
    return { controller, unlink: () => undefined };
  }
  const abort = () => controller.abort();
  if (signal.aborted) {
    abort();
  }
  signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    unlink: () => signal.removeEventListener("abort", abort),
  };
}

/**
 * Several chunks of a GeoVideo archive as one continuous timeline. Every
 * sample request is independent: aborting one leaves the decodes another
 * request needs. Manifests are cached; chunk sources are kept open in a
 * bounded LRU and released when evicted. The archive answers instants; it
 * neither drives a clock nor picks other archives (see pairChunkSpan).
 */
export class GeoVideoArchiveSource<TFrame = GeoVideoFrameData> {
  readonly id: string;
  /** Chunks sorted by start, without empty ranges. */
  readonly chunks: readonly GeoVideoArchiveChunk[];
  private readonly maxOpenChunks: number;
  private readonly frameCacheSize: number;
  private readonly prefetchAt: number;
  private readonly maxGap: number | undefined;
  private readonly loadManifest: (url: string) => Promise<GeoVideoManifest>;
  private readonly createFrameSource: (
    manifest: GeoVideoManifest,
    options: { cacheSize: number },
  ) => GeoVideoFrameReader<TFrame>;
  private readonly manifests = new Map<string, Promise<GeoVideoManifest>>();
  private readonly open = new Map<string, OpenChunk<TFrame>>();

  constructor(options: GeoVideoArchiveSourceOptions<TFrame>) {
    this.id = options.id;
    this.chunks = options.chunks
      .filter(
        (chunk) =>
          Number.isFinite(chunk.start) &&
          Number.isFinite(chunk.end) &&
          chunk.end >= chunk.start,
      )
      .sort((a, b) => a.start - b.start);
    this.maxOpenChunks = Math.max(2, options.maxOpenChunks ?? MAX_OPEN_CHUNKS);
    this.frameCacheSize = Math.max(
      1,
      options.frameCacheSize ?? FRAME_CACHE_SIZE,
    );
    this.prefetchAt = options.prefetchAt ?? PREFETCH_AT;
    this.maxGap = options.maxGap;
    this.loadManifest = options.loadManifest ?? loadGeoVideoManifest;
    this.createFrameSource =
      options.createFrameSource ??
      ((manifest, sourceOptions) =>
        createGeoVideoFrameSource(
          manifest,
          sourceOptions,
        ) as unknown as GeoVideoFrameReader<TFrame>);
  }

  /** First and last sample of the archive, or null without chunks. */
  get range(): [number, number] | null {
    const { chunks } = this;
    return chunks.length
      ? [chunks[0].start, Math.max(...chunks.map((chunk) => chunk.end))]
      : null;
  }

  /** The chunk whose sample range holds `time`, or null. */
  chunkAt(time: number): GeoVideoArchiveChunk | null {
    const index = this.chunkIndexAt(time);
    const chunk = index >= 0 ? this.chunks[index] : null;
    return chunk && time <= chunk.end ? chunk : null;
  }

  /** Every step time of the archive; loads all chunk manifests. */
  async steps(request: GeoVideoFrameRequest = {}): Promise<Float64Array> {
    if (request.signal?.aborted) {
      throw abortError();
    }
    const manifests = await abortable(
      Promise.all(this.chunks.map((chunk) => this.manifest(chunk))),
      request.signal,
    );
    return Float64Array.from(manifests.flatMap(geoVideoTimelineValues));
  }

  /**
   * The frames bracketing `time`, decoded; null out of coverage (before the
   * first step, after the last, or in a gap wider than `maxGap`).
   */
  async sample(
    time: number,
    request: GeoVideoFrameRequest & { mode?: GeoVideoSampleMode } = {},
  ): Promise<GeoVideoArchiveSample<TFrame> | null> {
    const { signal } = request;
    const mode = request.mode ?? "interpolate";
    if (signal?.aborted) {
      throw abortError();
    }
    const index = this.chunkIndexAt(time);
    if (index < 0) {
      return null;
    }
    const used: OpenChunk<TFrame>[] = [];
    const { controller, unlink } = linkedController(signal);
    try {
      const a = this.acquire(this.chunks[index], used);
      const first = await abortable(a.ready, controller.signal);
      const { times } = first;
      let pair: [OpenChunk<TFrame>, number, OpenChunk<TFrame>, number, number];
      if (time <= times[times.length - 1]) {
        const { step, fraction } = bracket(times, time);
        pair =
          mode === "discrete" || fraction === 0
            ? [a, step, a, step, 0]
            : [a, step, a, step + 1, fraction];
      } else {
        const following = this.chunks[index + 1];
        if (!following) {
          return null;
        }
        const b = this.acquire(following, used);
        const second = await abortable(b.ready, controller.signal);
        const last = times.length - 1;
        const from = times[last];
        const to = second.times[0];
        if (to - from > this.gapLimit(times, second.times)) {
          return null;
        }
        pair =
          mode === "discrete"
            ? [a, last, a, last, 0]
            : time >= to
              ? [b, 0, b, 0, 0]
              : [a, last, b, 0, (time - from) / (to - from)];
      }
      const [chunkA, stepA, chunkB, stepB, mix] = pair;
      const sameFrame = chunkA === chunkB && stepA === stepB;
      const frames = [this.frame(chunkA, stepA, controller.signal)];
      if (!sameFrame) {
        frames.push(this.frame(chunkB, stepB, controller.signal));
      }
      let decoded: GeoVideoArchiveFrame<TFrame>[];
      try {
        decoded = await Promise.all(frames);
      } catch (error) {
        // Leave the sibling decode to the requests still needing it.
        controller.abort();
        throw error;
      }
      this.prefetchAfter(index, time);
      return {
        time,
        a: decoded[0],
        b: decoded[sameFrame ? 0 : 1],
        mix,
      };
    } finally {
      unlink();
      for (const entry of used) {
        entry.users--;
      }
      this.trim();
    }
  }

  /** Open `chunk` and decode its first frame ahead of a request. */
  prefetch(chunk: GeoVideoArchiveChunk): void {
    if (this.open.has(chunk.key)) {
      return;
    }
    // Not pinned: a prefetched chunk is evicted like any unused one.
    const entry = this.touch(chunk);
    const prefetch = new AbortController();
    entry.prefetch = prefetch;
    entry.ready
      .then(({ source }) => source.frame(0, { signal: prefetch.signal }))
      .catch(() => {
        // A failed prefetch is reported by the request that needs it.
      })
      .finally(() => {
        if (entry.prefetch === prefetch) {
          entry.prefetch = null;
        }
      });
    this.trim();
  }

  /** Release every open chunk source; later requests reopen them. */
  release(): void {
    for (const entry of [...this.open.values()]) {
      this.close(entry);
    }
  }

  private chunkIndexAt(time: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.chunks[mid].start <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  private gapLimit(before: Float64Array, after: Float64Array): number {
    if (this.maxGap !== undefined) {
      return this.maxGap;
    }
    const intervals = [
      before.length > 1
        ? before[before.length - 1] - before[before.length - 2]
        : 0,
      after.length > 1 ? after[1] - after[0] : 0,
    ];
    const cadence = Math.max(...intervals);
    // Without a known cadence, a gap is only bridged under an explicit maxGap.
    return cadence > 0 ? cadence * GAP_TOLERANCE : -Infinity;
  }

  private prefetchAfter(index: number, time: number): void {
    const chunk = this.chunks[index];
    const next = this.chunks[index + 1];
    const span = chunk.end - chunk.start;
    const progress = span > 0 ? (time - chunk.start) / span : 1;
    if (next && progress > this.prefetchAt) {
      this.prefetch(next);
    }
  }

  private manifest(chunk: GeoVideoArchiveChunk): Promise<GeoVideoManifest> {
    let manifest = this.manifests.get(chunk.manifestUrl);
    if (!manifest) {
      manifest = this.loadManifest(chunk.manifestUrl);
      this.manifests.set(chunk.manifestUrl, manifest);
      manifest.catch(() => {
        if (this.manifests.get(chunk.manifestUrl) === manifest) {
          this.manifests.delete(chunk.manifestUrl);
        }
      });
    }
    return manifest;
  }

  /** The open chunk, pinned for a running sample listed in `used`. */
  private acquire(
    chunk: GeoVideoArchiveChunk,
    used: OpenChunk<TFrame>[],
  ): OpenChunk<TFrame> {
    const entry = this.touch(chunk);
    entry.users++;
    used.push(entry);
    return entry;
  }

  /** The open chunk, opened when needed, most recently used; not pinned. */
  private touch(chunk: GeoVideoArchiveChunk): OpenChunk<TFrame> {
    let entry = this.open.get(chunk.key);
    if (entry) {
      this.open.delete(chunk.key);
    } else {
      const created: OpenChunk<TFrame> = {
        chunk,
        ready: null as unknown as Promise<OpenedChunk<TFrame>>,
        opened: null,
        users: 0,
        prefetch: null,
        released: false,
      };
      created.ready = this.manifest(chunk).then((manifest) => {
        if (created.released) {
          throw abortError();
        }
        created.opened = {
          manifest,
          times: Float64Array.from(geoVideoTimelineValues(manifest)),
          grid: geoVideoGrid(manifest),
          source: this.createFrameSource(manifest, {
            cacheSize: this.frameCacheSize,
          }),
        };
        return created.opened;
      });
      created.ready.catch(() => {
        // A chunk that failed to open is retried by the next request.
        if (this.open.get(chunk.key) === created) {
          this.open.delete(chunk.key);
        }
      });
      entry = created;
    }
    this.open.set(chunk.key, entry);
    return entry;
  }

  private async frame(
    entry: OpenChunk<TFrame>,
    step: number,
    signal: AbortSignal,
  ): Promise<GeoVideoArchiveFrame<TFrame>> {
    const { manifest, times, grid, source } = await abortable(
      entry.ready,
      signal,
    );
    if (entry.released) {
      throw abortError();
    }
    const data = await source.frame(step, { signal });
    return {
      key: `${this.id}/${entry.chunk.key}/${step}`,
      chunk: entry.chunk,
      step,
      time: times[step],
      data,
      grid,
      manifest,
    };
  }

  /** Release least recently used chunks beyond the bound, unless in use. */
  private trim(): void {
    let excess = this.open.size - this.maxOpenChunks;
    for (const entry of [...this.open.values()]) {
      if (excess <= 0) {
        return;
      }
      if (entry.users === 0) {
        this.close(entry);
        excess--;
      }
    }
  }

  private close(entry: OpenChunk<TFrame>): void {
    entry.released = true;
    entry.prefetch?.abort();
    entry.prefetch = null;
    entry.opened?.source.release();
    entry.opened = null;
    if (this.open.get(entry.chunk.key) === entry) {
      this.open.delete(entry.chunk.key);
    }
  }
}
