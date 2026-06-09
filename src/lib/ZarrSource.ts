import { inflate } from "pako";
import Blosc from "numcodecs/blosc";
import type { Codec } from "numcodecs";
import type {
  ZarrConsolidatedMeta,
  ZarrArrayMeta,
  ZarrAttrs,
  DecodedChunk,
  ZarrPointSeriesResult,
  ZarrTimeDimension,
} from "./types";

interface CoordArrays {
  time: Float64Array | Float32Array;
  vertical: Float32Array; // "depth", "elevation", "level", etc. — empty ([0]) for surface-only datasets
  latitude: Float32Array;
  longitude: Float32Array;
}

type NumericArray = Float32Array | Float64Array;

/** Names that may represent the vertical coordinate. */
const VERTICAL_NAMES = ["depth", "elevation", "level", "altitude", "pressure_level"] as const;

class ZarrChunkFetchError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`Chunk fetch failed: ${status} ${url}`);
    this.name = "ZarrChunkFetchError";
    this.status = status;
    this.url = url;
  }
}

export class ZarrSource {
  private root: string;
  private meta: ZarrConsolidatedMeta | null = null;
  private coords: CoordArrays | null = null;
  private verticalName: string = "depth";
  private timeUnits: string = "";
  private cache = new Map<string, Float32Array>();
  private maxCacheSize: number;
  private abortControllers = new Map<string, AbortController>();
  private bloscCodecCache = new Map<string, Codec>();

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

  getTimeDimension(): ZarrTimeDimension {
    const time = this.getCoords().time;
    const size = time.length;
    const min = size ? this.zarrTimeToMs(time[0]) : NaN;
    const max = size ? this.zarrTimeToMs(time[size - 1]) : NaN;
    const rawStep =
      size > 1 ? this.zarrTimeToMs(time[1]) - this.zarrTimeToMs(time[0]) : undefined;
    const step = normalizeTimeStep(rawStep);

    return {
      min,
      max,
      step,
      size,
      units: this.timeUnits,
    };
  }

  getDimensions(variable: string): string[] {
    const attrs = this.getAttrs(variable);
    return (attrs._ARRAY_DIMENSIONS as string[]) ?? [
      "time",
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
    return this.findNearestIndex(coords.time, this.msToZarrTime(targetMs));
  }

  /**
   * Convert a Unix-ms timestamp to the native time units used by this zarr
   * (read from the time variable's .zattrs "units" field).
   * Falls back to a magnitude heuristic when units are absent or unparseable.
   */
  private msToZarrTime(ms: number): number {
    const units = this.timeUnits;
    const m = units.match(
      /^(milliseconds?|seconds?|hours?|days?)\s+since\s+(\S+)/i,
    );
    if (m) {
      const refMs = new Date(m[2]).getTime();
      const delta = ms - refMs;
      const u = m[1].toLowerCase();
      if (u.startsWith("ms") || u.startsWith("milli")) return delta;
      if (u.startsWith("s")) return delta / 1000;
      if (u.startsWith("h")) return delta / 3600000;
      if (u.startsWith("d")) return delta / 86400000;
    }
    // Fallback heuristic based on magnitude of the first coordinate value
    const sample = this.coords!.time[0];
    if (sample > 1e12) return ms;
    if (sample > 1e9) return ms / 1000;
    // Assume days since 1950-01-01 (CF convention)
    const ref = new Date("1950-01-01T00:00:00Z").getTime();
    return (ms - ref) / 86400000;
  }

  private zarrTimeToMs(value: number): number {
    const units = this.timeUnits;
    const m = units.match(
      /^(milliseconds?|seconds?|hours?|days?)\s+since\s+(\S+)/i,
    );
    if (m) {
      const refMs = new Date(m[2]).getTime();
      const u = m[1].toLowerCase();
      if (u.startsWith("ms") || u.startsWith("milli")) return refMs + value;
      if (u.startsWith("s")) return refMs + value * 1000;
      if (u.startsWith("h")) return refMs + value * 3600000;
      if (u.startsWith("d")) return refMs + value * 86400000;
    }
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    const ref = new Date("1950-01-01T00:00:00Z").getTime();
    return ref + value * 86400000;
  }

  private findNearestLongitudeIndex(longitude: number): number {
    const lon = this.getCoords().longitude;
    const first = lon[0];
    const last = lon[lon.length - 1];
    let normalized = longitude;

    if (first >= 0 && last > 180) {
      normalized = ((longitude % 360) + 360) % 360;
    } else {
      normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
    }

    return this.findNearestIndex(lon, normalized);
  }

  private async sampleVariableAt(
    variable: string,
    indices: {
      timeIdx: number;
      depthIdx: number;
      latIdx: number;
      lonIdx: number;
    },
  ): Promise<number> {
    const dims = this.getDimensions(variable);
    const chunkShape = this.getChunkShape(variable);
    const shape = this.getShape(variable);
    const chunkIndices = new Array(dims.length).fill(0);
    const localIndices = new Array(dims.length).fill(0);

    for (let dimIdx = 0; dimIdx < dims.length; dimIdx++) {
      const dim = dims[dimIdx];
      let globalIdx = 0;
      if (dim === "time") {
        globalIdx = indices.timeIdx;
      } else if (dim === "latitude") {
        globalIdx = indices.latIdx;
      } else if (dim === "longitude") {
        globalIdx = indices.lonIdx;
      } else if (dim === this.verticalName || VERTICAL_NAMES.includes(dim as typeof VERTICAL_NAMES[number])) {
        globalIdx = indices.depthIdx;
      }

      globalIdx = Math.max(0, Math.min(shape[dimIdx] - 1, globalIdx));
      chunkIndices[dimIdx] = Math.floor(globalIdx / chunkShape[dimIdx]);
      localIndices[dimIdx] = globalIdx - chunkIndices[dimIdx] * chunkShape[dimIdx];
    }

    let chunk: Float32Array;
    try {
      chunk = await this.fetchChunk(variable, chunkIndices);
    } catch (err) {
      if (
        err instanceof ZarrChunkFetchError &&
        (err.status === 403 || err.status === 404)
      ) {
        return NaN;
      }
      throw err;
    }

    const offset = this.getFlatOffset(variable, localIndices);
    return offset < chunk.length ? chunk[offset] : NaN;
  }

  private getFlatOffset(variable: string, localIndices: number[]): number {
    const meta = this.getArrayMeta(variable);
    const chunkShape = meta.chunks;

    if (meta.order === "F") {
      let offset = 0;
      let stride = 1;
      for (let i = 0; i < localIndices.length; i++) {
        offset += localIndices[i] * stride;
        stride *= chunkShape[i];
      }
      return offset;
    }

    let offset = 0;
    for (let i = 0; i < localIndices.length; i++) {
      offset = offset * chunkShape[i] + localIndices[i];
    }
    return offset;
  }

  findDepthIndex(depth: number): number {
    return this.findNearestIndex(this.getCoords().vertical, depth);
  }

  async sampleTimeSeries(options: {
    variables: string[];
    longitude: number;
    latitude: number;
    depth?: number;
    timeStartIndex?: number;
    timeEndIndex?: number;
    stride?: number;
    stopAfterMissingSamples?: number;
  }): Promise<ZarrPointSeriesResult> {
    await this.init();
    const coords = this.getCoords();
    const lonIdx = this.findNearestLongitudeIndex(options.longitude);
    const latIdx = this.findNearestIndex(coords.latitude, options.latitude);
    const depthIdx = this.findDepthIndex(options.depth ?? 0);
    const start = Math.max(0, options.timeStartIndex ?? 0);
    const end = Math.min(
      coords.time.length - 1,
      options.timeEndIndex ?? coords.time.length - 1,
    );
    const stride = Math.max(1, Math.floor(options.stride ?? 1));
    const stopAfterMissing = Math.max(0, Math.floor(options.stopAfterMissingSamples ?? 0));
    let missingRun = 0;
    const points: ZarrPointSeriesResult["points"] = [];

    for (let timeIdx = start; timeIdx <= end; timeIdx += stride) {
      const values: Record<string, number> = {};
      for (const variable of options.variables) {
        values[variable] = await this.sampleVariableAt(variable, {
          timeIdx,
          depthIdx,
          latIdx,
          lonIdx,
        });
      }
      const time = this.zarrTimeToMs(coords.time[timeIdx]);
      points.push({ axisValue: time, time, depth: coords.vertical[depthIdx], values });

      const allMissing = options.variables.every(
        (variable) => !Number.isFinite(values[variable]),
      );
      missingRun = allMissing ? missingRun + 1 : 0;
      if (stopAfterMissing > 0 && missingRun >= stopAfterMissing) break;
    }

    return {
      longitude: coords.longitude[lonIdx],
      latitude: coords.latitude[latIdx],
      depth: coords.vertical[depthIdx],
      points,
    };
  }

  async sampleVerticalProfile(options: {
    variables: string[];
    longitude: number;
    latitude: number;
    time: string | number;
    maxDepths?: number;
    stride?: number;
    stopAfterMissingSamples?: number;
  }): Promise<ZarrPointSeriesResult> {
    await this.init();
    const coords = this.getCoords();
    const lonIdx = this.findNearestLongitudeIndex(options.longitude);
    const latIdx = this.findNearestIndex(coords.latitude, options.latitude);
    const timeIdx = this.findTimeIndex(options.time);
    const stopAfterMissing = Math.max(0, Math.floor(options.stopAfterMissingSamples ?? 0));
    let missingRun = 0;
    const points: ZarrPointSeriesResult["points"] = [];

    let depthOrder = Array.from(
      { length: coords.vertical.length },
      (_, index) => index,
    ).sort((a, b) => coords.vertical[a] - coords.vertical[b]);
    const maxDepths = Math.max(1, Math.floor(options.maxDepths ?? depthOrder.length));
    const stride = Math.max(
      1,
      Math.floor(options.stride ?? Math.ceil(depthOrder.length / maxDepths)),
    );
    depthOrder = depthOrder.filter((_, index) => index % stride === 0).slice(0, maxDepths);

    for (const depthIdx of depthOrder) {
      const values: Record<string, number> = {};
      for (const variable of options.variables) {
        values[variable] = await this.sampleVariableAt(variable, {
          timeIdx,
          depthIdx,
          latIdx,
          lonIdx,
        });
      }
      const depth = coords.vertical[depthIdx];
      points.push({
        axisValue: depth,
        time: this.zarrTimeToMs(coords.time[timeIdx]),
        depth,
        values,
      });

      const allMissing = options.variables.every(
        (variable) => !Number.isFinite(values[variable]),
      );
      missingRun = allMissing ? missingRun + 1 : 0;
      if (stopAfterMissing > 0 && missingRun >= stopAfterMissing) break;
    }

    return {
      longitude: coords.longitude[lonIdx],
      latitude: coords.latitude[latIdx],
      time: this.zarrTimeToMs(coords.time[timeIdx]),
      points,
    };
  }

  /** Return the actual name of the vertical dimension ("depth" or "elevation"). */
  getVerticalDimName(): string {
    return this.verticalName;
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
    const meta = this.getArrayMeta(variable);
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 404) {
        const missing = createMissingChunk(meta);
        this.cacheChunk(cacheKey, missing);
        this.abortControllers.delete(cacheKey);
        return missing;
      }
      this.abortControllers.delete(cacheKey);
      throw new ZarrChunkFetchError(resp.status, url);
    }

    const raw = new Uint8Array(await resp.arrayBuffer());
    const decompressed = toFloat32Array(
      await this.decompress(raw, meta, variable),
    );

    this.cacheChunk(cacheKey, decompressed);
    this.abortControllers.delete(cacheKey);

    return decompressed;
  }

  cancelAll(): void {
    for (const ctrl of this.abortControllers.values()) {
      ctrl.abort();
    }
    this.abortControllers.clear();
  }

  private cacheChunk(key: string, data: Float32Array): void {
    // Evict old entries if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, data);
  }

  private getBloscCodec(meta: ZarrArrayMeta): Codec {
    const cfg = meta.compressor!;
    const key = `${cfg.cname ?? "lz4"}-${cfg.clevel ?? 5}-${cfg.shuffle ?? 1}-${cfg.blocksize ?? 0}`;
    let codec = this.bloscCodecCache.get(key);
    if (!codec) {
      codec = Blosc.fromConfig({
        id: "blosc",
        cname: cfg.cname ?? "lz4",
        clevel: cfg.clevel ?? 5,
        shuffle: cfg.shuffle ?? 1,
        blocksize: cfg.blocksize ?? 0,
      });
      this.bloscCodecCache.set(key, codec);
    }
    return codec;
  }

  private async decompress(
    raw: Uint8Array,
    meta: ZarrArrayMeta,
    variable?: string,
  ): Promise<NumericArray> {
    let bytes: Uint8Array;

    if (meta.compressor) {
      switch (meta.compressor.id) {
        case "zlib":
        case "gzip":
          bytes = inflate(raw);
          break;
        case "blosc": {
          const codec = this.getBloscCodec(meta);
          bytes = await codec.decode(raw);
          break;
        }
        default:
          throw new Error(`Unsupported compressor: ${meta.compressor.id}`);
      }
    } else {
      bytes = raw;
    }

    // Parse dtype
    let result: NumericArray;
    const dtype = meta.dtype;
    if (dtype === "<f4" || dtype === "|f4") {
      result = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 4,
      );
    } else if (dtype === "<f8" || dtype === "|f8") {
      result = new Float64Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 8,
      );
    } else if (dtype === "<i2" || dtype === "|i2") {
      const i16 = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 2,
      );
      result = Float32Array.from(i16);
    } else if (dtype === "<i4" || dtype === "|i4") {
      const i32 = new Int32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 4,
      );
      result = Float32Array.from(i32);
    } else if (dtype === "<i8" || dtype === "|i8") {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const count = bytes.byteLength / 8;
      result = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        result[i] = Number(view.getBigInt64(i * 8, true));
      }
    } else {
      throw new Error(`Unsupported dtype: ${dtype}`);
    }

    // Replace fill values with NaN so downstream code can detect nodata
    const fillValue = meta.fill_value;
    if (fillValue != null && typeof fillValue === "number" && !isNaN(fillValue)) {
      for (let i = 0; i < result.length; i++) {
        if (result[i] === fillValue) result[i] = NaN;
      }
    }

    // Apply CF scale_factor / add_offset if present in .zattrs
    if (variable) {
      const attrs = this.getAttrs(variable);
      const scale = attrs.scale_factor as number | undefined;
      const offset = attrs.add_offset as number | undefined;
      if (scale != null || offset != null) {
        const s = scale ?? 1;
        const o = offset ?? 0;
        for (let i = 0; i < result.length; i++) {
          if (!isNaN(result[i])) result[i] = result[i] * s + o;
        }
      }
    }

    return result;
  }

  private async loadCoordinates(): Promise<void> {
    const loadCoord = async (
      name: string,
    ): Promise<Float32Array | Float64Array> => {
      const meta = this.getArrayMeta(name);
      const actualSize = meta.shape[0];
      const chunkCount = Math.ceil(actualSize / meta.chunks[0]);
      const arrays: NumericArray[] = [];

      for (let i = 0; i < chunkCount; i++) {
        const url = `${this.root}/${name}/${i}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch coord ${name}/${i}`);
        const raw = new Uint8Array(await resp.arrayBuffer());
        arrays.push(await this.decompress(raw, meta));
      }

      // Merge chunks and truncate to the declared shape size.
      // Some zarr writers pad the last chunk to the full chunk size with
      // fill/zero values; truncating prevents spurious out-of-bounds lookups.
      if (arrays.length === 1) {
        return arrays[0].length > actualSize
          ? arrays[0].subarray(0, actualSize)
          : arrays[0];
      }
      const ArrayCtor = arrays.some((arr) => arr instanceof Float64Array)
        ? Float64Array
        : Float32Array;
      const merged = new ArrayCtor(actualSize);
      let offset = 0;
      for (const arr of arrays) {
        const toCopy = Math.min(arr.length, actualSize - offset);
        merged.set(arr.subarray(0, toCopy), offset);
        offset += toCopy;
        if (offset >= actualSize) break;
      }
      return merged;
    };

    // Detect vertical dimension name: try each known name
    let verticalName: string | null = null;
    for (const name of VERTICAL_NAMES) {
      const key = `${name}/.zarray`;
      if (this.meta!.metadata[key] && "dtype" in this.meta!.metadata[key]) {
        verticalName = name;
        break;
      }
    }

    this.verticalName = verticalName ?? "";

    // Read time units before loading coordinates so msToZarrTime works correctly
    this.timeUnits = (this.getAttrs("time").units as string) ?? "";

    const [time, latitude, longitude] = await Promise.all([
      loadCoord("time"),
      loadCoord("latitude"),
      loadCoord("longitude"),
    ]);

    let vertical: Float32Array;
    if (verticalName) {
      const rawVertical = await loadCoord(verticalName);
      // Normalize elevation (negative) to depth (positive)
      vertical = rawVertical as Float32Array;
      if (vertical.length > 0 && vertical[0] < 0) {
        vertical = new Float32Array(vertical.length);
        for (let i = 0; i < rawVertical.length; i++) {
          vertical[i] = -(rawVertical as Float32Array)[i];
        }
      }
    } else {
      // Surface-only dataset — synthesize a single level at 0
      vertical = new Float32Array([0]);
    }

    this.coords = {
      time: time as Float64Array | Float32Array,
      vertical,
      latitude: latitude as Float32Array,
      longitude: longitude as Float32Array,
    };
  }
}

function toFloat32Array(array: NumericArray): Float32Array {
  return array instanceof Float32Array ? array : Float32Array.from(array);
}

function createMissingChunk(meta: ZarrArrayMeta): Float32Array {
  const size = meta.chunks.reduce((total, chunkSize) => total * chunkSize, 1);
  const data = new Float32Array(size);
  data.fill(NaN);
  return data;
}

function normalizeTimeStep(step?: number): number | undefined {
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) {
    return step;
  }

  const commonSteps = [
    60 * 1000,
    3 * 60 * 1000,
    5 * 60 * 1000,
    10 * 60 * 1000,
    15 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
    3 * 60 * 60 * 1000,
    6 * 60 * 60 * 1000,
    12 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
  ];

  for (const candidate of commonSteps) {
    if (Math.abs(step - candidate) <= Math.max(1000, candidate * 0.02)) {
      return candidate;
    }
  }

  return Math.round(step);
}
