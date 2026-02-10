import { inflate } from "pako";
import type {
  ZarrConsolidatedMeta,
  ZarrArrayMeta,
  ZarrAttrs,
  DecodedChunk,
} from "./types.js";

interface CoordArrays {
  time: Float64Array | Float32Array;
  depth: Float32Array;
  latitude: Float32Array;
  longitude: Float32Array;
}

export class ZarrSource {
  private root: string;
  private meta: ZarrConsolidatedMeta | null = null;
  private coords: CoordArrays | null = null;
  private cache = new Map<string, Float32Array>();
  private maxCacheSize: number;
  private abortControllers = new Map<string, AbortController>();

  constructor(root: string, maxCacheSize = 200) {
    this.root = root.replace(/\/$/, "");
    this.maxCacheSize = maxCacheSize;
  }

  async init(): Promise<void> {
    if (this.meta) return;
    const resp = await fetch(`${this.root}/.zmetadata`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch .zmetadata: ${resp.status}`);
    }
    this.meta = (await resp.json()) as ZarrConsolidatedMeta;
    await this.loadCoordinates();
  }

  private getArrayMeta(variable: string): ZarrArrayMeta {
    const key = `${variable}/.zarray`;
    const m = this.meta!.metadata[key];
    if (!m || !("dtype" in m)) {
      throw new Error(`No .zarray for ${variable}`);
    }
    return m as ZarrArrayMeta;
  }

  private getAttrs(variable: string): ZarrAttrs {
    const key = `${variable}/.zattrs`;
    return (this.meta!.metadata[key] as ZarrAttrs) ?? {};
  }

  getDimensionSeparator(variable: string): string {
    const meta = this.getArrayMeta(variable);
    return meta.dimension_separator ?? ".";
  }

  getShape(variable: string): number[] {
    return this.getArrayMeta(variable).shape;
  }

  getChunkShape(variable: string): number[] {
    return this.getArrayMeta(variable).chunks;
  }

  getCoords(): CoordArrays {
    if (!this.coords) throw new Error("Call init() first");
    return this.coords;
  }

  getDimensions(variable: string): string[] {
    const attrs = this.getAttrs(variable);
    return (attrs._ARRAY_DIMENSIONS as string[]) ?? [
      "time",
      "depth",
      "latitude",
      "longitude",
    ];
  }

  findNearestIndex(array: Float32Array | Float64Array, value: number): number {
    let best = 0;
    let bestDist = Math.abs(array[0] - value);
    for (let i = 1; i < array.length; i++) {
      const dist = Math.abs(array[i] - value);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  findTimeIndex(time: string | number): number {
    const coords = this.getCoords();
    let targetMs: number;
    if (typeof time === "string") {
      targetMs = new Date(time).getTime();
    } else {
      targetMs = time;
    }
    // Time coords may be in various units - try to match
    const timeArr = coords.time;
    // Heuristic: if values are > 1e12, they're likely ms since epoch
    // If values are < 1e6, they're likely days since some reference
    const sample = timeArr[0];
    if (sample > 1e12) {
      return this.findNearestIndex(timeArr, targetMs);
    } else if (sample > 1e9) {
      return this.findNearestIndex(timeArr, targetMs / 1000);
    } else {
      // Assume days since 1950-01-01 (CF convention)
      const ref = new Date("1950-01-01T00:00:00Z").getTime();
      const days = (targetMs - ref) / 86400000;
      return this.findNearestIndex(timeArr, days);
    }
  }

  findDepthIndex(depth: number): number {
    return this.findNearestIndex(this.getCoords().depth, depth);
  }

  /**
   * Get chunk indices that intersect a geographic bounding box.
   */
  getChunksForBounds(
    variable: string,
    timeIdx: number,
    depthIdx: number,
    bounds: { west: number; south: number; east: number; north: number },
  ): Array<{
    timeIdx: number;
    depthIdx: number;
    latIdx: number;
    lonIdx: number;
    latRange: [number, number];
    lonRange: [number, number];
    latSize: number;
    lonSize: number;
  }> {
    const coords = this.getCoords();
    const chunkShape = this.getChunkShape(variable);
    const dims = this.getDimensions(variable);
    const latDim = dims.indexOf("latitude");
    const lonDim = dims.indexOf("longitude");
    const latChunkSize = chunkShape[latDim];
    const lonChunkSize = chunkShape[lonDim];

    const lat = coords.latitude;
    const lon = coords.longitude;

    // Find lat/lon chunk ranges
    const latStart = this.findNearestIndex(lat, bounds.north); // north = smaller index if lat descending
    const latEnd = this.findNearestIndex(lat, bounds.south);
    const lonStart = this.findNearestIndex(lon, bounds.west);
    const lonEnd = this.findNearestIndex(lon, bounds.east);

    const minLat = Math.min(latStart, latEnd);
    const maxLat = Math.max(latStart, latEnd);
    const minLon = Math.min(lonStart, lonEnd);
    const maxLon = Math.max(lonStart, lonEnd);

    const latChunkStart = Math.floor(minLat / latChunkSize);
    const latChunkEnd = Math.floor(maxLat / latChunkSize);
    const lonChunkStart = Math.floor(minLon / lonChunkSize);
    const lonChunkEnd = Math.floor(maxLon / lonChunkSize);

    const shape = this.getShape(variable);
    const totalLatSize = shape[latDim];
    const totalLonSize = shape[lonDim];

    const results: Array<{
      timeIdx: number;
      depthIdx: number;
      latIdx: number;
      lonIdx: number;
      latRange: [number, number];
      lonRange: [number, number];
      latSize: number;
      lonSize: number;
    }> = [];

    for (let li = latChunkStart; li <= latChunkEnd; li++) {
      for (let lo = lonChunkStart; lo <= lonChunkEnd; lo++) {
        const latOff = li * latChunkSize;
        const lonOff = lo * lonChunkSize;
        const latSize = Math.min(latChunkSize, totalLatSize - latOff);
        const lonSize = Math.min(lonChunkSize, totalLonSize - lonOff);

        results.push({
          timeIdx,
          depthIdx,
          latIdx: li,
          lonIdx: lo,
          latRange: [lat[latOff], lat[latOff + latSize - 1]],
          lonRange: [lon[lonOff], lon[lonOff + lonSize - 1]],
          latSize,
          lonSize,
        });
      }
    }
    return results;
  }

  async fetchChunk(
    variable: string,
    indices: number[],
  ): Promise<Float32Array> {
    const sep = this.getDimensionSeparator(variable);
    const key = indices.join(sep);
    const cacheKey = `${variable}/${key}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Cancel any existing fetch for this key
    this.abortControllers.get(cacheKey)?.abort();
    const controller = new AbortController();
    this.abortControllers.set(cacheKey, controller);

    const url = `${this.root}/${variable}/${key}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Chunk fetch failed: ${resp.status} ${url}`);
    }

    const raw = new Uint8Array(await resp.arrayBuffer());
    const meta = this.getArrayMeta(variable);
    const decompressed = this.decompress(raw, meta);

    // Evict old entries if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, decompressed);
    this.abortControllers.delete(cacheKey);

    return decompressed;
  }

  cancelAll(): void {
    for (const ctrl of this.abortControllers.values()) {
      ctrl.abort();
    }
    this.abortControllers.clear();
  }

  private decompress(raw: Uint8Array, meta: ZarrArrayMeta): Float32Array {
    let bytes: Uint8Array;

    if (meta.compressor) {
      switch (meta.compressor.id) {
        case "zlib":
        case "gzip":
          bytes = inflate(raw);
          break;
        default:
          throw new Error(`Unsupported compressor: ${meta.compressor.id}`);
      }
    } else {
      bytes = raw;
    }

    // Parse dtype
    const dtype = meta.dtype;
    if (dtype === "<f4" || dtype === "|f4") {
      return new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 4,
      );
    } else if (dtype === "<f8" || dtype === "|f8") {
      const f64 = new Float64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 8,
      );
      return Float32Array.from(f64);
    } else if (dtype === "<i4" || dtype === "|i4") {
      const i32 = new Int32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 4,
      );
      return Float32Array.from(i32);
    } else if (dtype === "<i8" || dtype === "|i8") {
      // int64 - read as pairs of int32 (loses precision for large values)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = bytes.byteLength / 8;
      const result = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        // Read as float64 reinterpretation for time coordinates
        result[i] = Number(view.getBigInt64(i * 8, true));
      }
      return result;
    }
    throw new Error(`Unsupported dtype: ${dtype}`);
  }

  private async loadCoordinates(): Promise<void> {
    const loadCoord = async (
      name: string,
    ): Promise<Float32Array | Float64Array> => {
      const meta = this.getArrayMeta(name);
      const sep = meta.dimension_separator ?? ".";
      const chunkCount = Math.ceil(meta.shape[0] / meta.chunks[0]);
      const arrays: Float32Array[] = [];

      for (let i = 0; i < chunkCount; i++) {
        const url = `${this.root}/${name}/${i}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch coord ${name}/${i}`);
        const raw = new Uint8Array(await resp.arrayBuffer());
        arrays.push(this.decompress(raw, meta));
      }

      if (arrays.length === 1) return arrays[0];
      const total = arrays.reduce((s, a) => s + a.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const arr of arrays) {
        merged.set(arr, offset);
        offset += arr.length;
      }
      return merged;
    };

    const [time, depth, latitude, longitude] = await Promise.all([
      loadCoord("time"),
      loadCoord("depth"),
      loadCoord("latitude"),
      loadCoord("longitude"),
    ]);

    this.coords = {
      time: time as Float64Array | Float32Array,
      depth: depth as Float32Array,
      latitude: latitude as Float32Array,
      longitude: longitude as Float32Array,
    };
  }
}
