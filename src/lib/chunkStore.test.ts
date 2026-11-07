import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheChunkStore, chunkRevision } from "./chunkStore";

/** Cache Storage in memory, enough for the store: open, match, put, keys, delete. */
function fakeCaches(): CacheStorage {
  const caches = new Map<string, Map<string, Response>>();
  const key = (request: RequestInfo | URL) =>
    typeof request === "string"
      ? request
      : request instanceof URL
        ? request.href
        : request.url;
  return {
    open: async (name: string) => {
      const entries = caches.get(name) ?? new Map<string, Response>();
      caches.set(name, entries);
      return {
        match: async (request: RequestInfo | URL) =>
          entries.get(key(request))?.clone(),
        put: async (request: RequestInfo | URL, response: Response) => {
          entries.set(key(request), response);
        },
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
        delete: async (request: RequestInfo | URL) =>
          entries.delete(key(request)),
      } as unknown as Cache;
    },
  } as unknown as CacheStorage;
}

describe("chunkRevision", () => {
  const dims = ["time", "depth", "latitude", "longitude"];
  const shape = [561, 40, 418, 360];
  const chunks = [60, 1, 60, 60];

  it("is empty for chunks of complete time chunks, which never change", () => {
    expect(chunkRevision(dims, shape, chunks, [0, 3, 1, 2])).toBe("");
    expect(chunkRevision(dims, shape, chunks, [8, 0, 0, 0])).toBe("");
  });

  it("is the time length for the last time chunk, which grows", () => {
    expect(chunkRevision(dims, shape, chunks, [9, 0, 0, 0])).toBe("t=561");
    expect(
      chunkRevision(dims, [562, ...shape.slice(1)], chunks, [9, 0, 0, 0]),
    ).toBe("t=562");
  });

  it("is empty without a time axis", () => {
    expect(
      chunkRevision(["latitude", "longitude"], [10, 10], [5, 5], [1, 1]),
    ).toBe("");
  });
});

describe("cacheChunkStore", () => {
  beforeEach(() => {
    vi.stubGlobal("caches", fakeCaches());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the stored bytes for their revision only", async () => {
    const store = cacheChunkStore("test");
    const url = "https://example.org/v2/geoChunked.zarr/pottmp/9.0.0.0";
    await store.put(url, new Uint8Array([1, 2, 3]), "t=561");
    expect(Array.from((await store.get(url, "t=561"))!)).toEqual([1, 2, 3]);
    // A month later the last time chunk has grown: the stored one is stale.
    expect(await store.get(url, "t=562")).toBeUndefined();
    await store.put(url, new Uint8Array([4]), "t=562");
    expect(Array.from((await store.get(url, "t=562"))!)).toEqual([4]);
    expect(await store.get(`${url}x`)).toBeUndefined();
  });

  it("lists entries by prefix with their size and date, and deletes them", async () => {
    const store = cacheChunkStore("test");
    const base = "https://example.org/v2/geoChunked.zarr";
    await store.put(`${base}/pottmp/0.0.0.0`, new Uint8Array(10));
    await store.put(`${base}/pottmp/0.1.0.0`, new Uint8Array(20));
    await store.put(`${base}/pottmp_anom/0.0.0.0`, new Uint8Array(5));
    const entries = await store.entries(`${base}/pottmp/`);
    expect(entries.map((entry) => entry.size).sort()).toEqual([10, 20]);
    expect(entries.every((entry) => entry.storedAt > 0)).toBe(true);
    await store.delete(entries.map((entry) => entry.url));
    expect(await store.entries(`${base}/pottmp/`)).toEqual([]);
    expect(await store.entries(base)).toHaveLength(1);
  });

  it("keeps nothing where Cache Storage is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    const store = cacheChunkStore("test");
    await store.put("https://example.org/a", new Uint8Array([1]));
    expect(await store.get("https://example.org/a")).toBeUndefined();
    expect(await store.entries()).toEqual([]);
  });
});
