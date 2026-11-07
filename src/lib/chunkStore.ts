/**
 * A persistent store of Zarr chunks, as the compressed bytes the server sent,
 * in the browser's Cache Storage. ZarrSource reads it before the network when
 * given one (opt-in), so an app opens the chunks of a past session at once.
 *
 * Chunks of the to_zarr stores never change once written, except those of the
 * last time chunk, which grows as months are appended. Those carry a revision
 * (the length of the time axis): a stored chunk of another revision is stale
 * and is read again, then replaced under the same key. A new store version has
 * new URLs, so it never meets the chunks of the previous one.
 */

/** A stored chunk, without its bytes. */
export interface ChunkEntry {
  url: string;
  /** Bytes on disk (compressed). */
  size: number;
  /** When the chunk was stored, ms since the epoch. */
  storedAt: number;
  revision: string;
}

export interface ChunkStore {
  /** The bytes of `url`, or undefined when missing or of another revision. */
  get(url: string, revision?: string): Promise<Uint8Array | undefined>;
  put(url: string, bytes: Uint8Array, revision?: string): Promise<void>;
  /** Every stored chunk whose URL starts with `prefix`. */
  entries(prefix?: string): Promise<ChunkEntry[]>;
  /** Removes these chunks. */
  delete(urls: Iterable<string>): Promise<void>;
  /** Origin storage use and quota, bytes, when the browser reports them. */
  estimate(): Promise<{ usage: number; quota: number } | undefined>;
}

const SIZE = "x-zartigl-size";
const STORED_AT = "x-zartigl-stored-at";
const REVISION = "x-zartigl-revision";

/**
 * The chunk revision a store expects for `indices` of a variable: the length of
 * the time axis for chunks of the last time chunk, which grows; empty for every
 * other chunk, which never changes.
 */
export function chunkRevision(
  dimensions: readonly string[],
  shape: readonly number[],
  chunks: readonly number[],
  indices: readonly number[],
): string {
  const axis = dimensions.indexOf("time");
  if (axis < 0 || !shape[axis] || !chunks[axis]) {
    return "";
  }
  const last = Math.floor((shape[axis] - 1) / chunks[axis]);
  return indices[axis] === last ? `t=${shape[axis]}` : "";
}

/**
 * A ChunkStore in Cache Storage `name`; a store that keeps nothing where Cache
 * Storage is unavailable (insecure context, some private modes), so callers need no check.
 */
export function cacheChunkStore(name = "zartigl-chunks-v1"): ChunkStore {
  const storage: CacheStorage | undefined =
    typeof caches === "undefined" ? undefined : caches;
  if (!storage) {
    return {
      get: async () => undefined,
      put: async () => {},
      entries: async () => [],
      delete: async () => {},
      estimate: async () => undefined,
    };
  }
  let opened: Promise<Cache> | null = null;
  const open = () => (opened ??= storage.open(name));
  let persisted = false;
  const persist = () => {
    if (!persisted && typeof navigator !== "undefined") {
      persisted = true;
      void navigator.storage?.persist?.().catch(() => false);
    }
  };
  return {
    async get(url, revision = "") {
      try {
        const response = await (await open()).match(url);
        if (!response || (response.headers.get(REVISION) ?? "") !== revision) {
          return undefined;
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        return undefined;
      }
    },
    async put(url, bytes, revision = "") {
      persist();
      try {
        const body = new Uint8Array(bytes);
        await (
          await open()
        ).put(
          url,
          new Response(body, {
            headers: {
              "content-type": "application/octet-stream",
              [SIZE]: String(body.byteLength),
              [STORED_AT]: String(Date.now()),
              [REVISION]: revision,
            },
          }),
        );
      } catch {
        // Quota or private mode: the chunk is only kept in memory.
      }
    },
    async entries(prefix = "") {
      try {
        const cache = await open();
        const result: ChunkEntry[] = [];
        for (const request of await cache.keys()) {
          if (!request.url.startsWith(prefix)) {
            continue;
          }
          const response = await cache.match(request);
          if (!response) {
            continue;
          }
          result.push({
            url: request.url,
            size: Number(response.headers.get(SIZE) ?? 0),
            storedAt: Number(response.headers.get(STORED_AT) ?? 0),
            revision: response.headers.get(REVISION) ?? "",
          });
        }
        return result;
      } catch {
        return [];
      }
    },
    async delete(urls) {
      try {
        const cache = await open();
        await Promise.all(Array.from(urls, (url) => cache.delete(url)));
      } catch {
        // Nothing to remove.
      }
    },
    async estimate() {
      try {
        const estimate = await navigator.storage?.estimate?.();
        return estimate
          ? { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
