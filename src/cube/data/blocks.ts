/**
 * Five-year blocks of the cube, read from the point-series store
 * (geoChunked.zarr, chunks of 60 months × 1 level × 60 × 60 cells). A block is
 * one time chunk of every tile and level the box needs for one variable, kept
 * as int16 codes at the store's own precision (about 44 MB), so three blocks
 * stay well under 200 MB.
 */

import type { ZarrSource } from "../../lib/ZarrSource";
import type { Box } from "./box";
import { depthWeights, interpolate } from "./depth";

/** A store variable the cube reads, with its int16 precision. */
export interface CubeVariable {
  name: string;
  /** Degrees per int16 code: the store's own scale factor. */
  scale: number;
}

/** Absolute potential temperature. */
export const POTTMP: CubeVariable = { name: "pottmp", scale: 0.002 };
/** Departure from the 1991–2020 monthly climatology. */
export const POTTMP_ANOM: CubeVariable = { name: "pottmp_anom", scale: 0.001 };
/** Code of a missing cell (land, below the sea floor). */
export const MISSING = -32768;

export interface Block {
  index: number;
  /** First month of the block, as an index on the store's time axis. */
  start: number;
  months: number;
  /** Degrees per code. */
  scale: number;
  /** Codes in [month][level][lat][lon] order. */
  codes: Int16Array;
}

export interface BlockProgress {
  index: number;
  done: number;
  total: number;
}

/** What a block loader needs from ZarrSource. */
export type ChunkReader = Pick<ZarrSource, "fetchChunkResult">;

/** Runs `tasks` with at most `limit` in flight. */
async function pooled<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return results;
}

/** Offset of a cell in a block's codes. */
function cellOffset(
  box: Box,
): (m: number, k: number, r: number, c: number) => number {
  const rows = box.lat.index.length;
  const cols = box.lon.index.length;
  const levels = box.depth.length;
  return (m, k, r, c) => ((m * levels + k) * rows + r) * cols + c;
}

/**
 * Reads a block of `variable`: every (level, tile) chunk of time chunk `index`,
 * copied into the box. `timeChunk` and the tile size come from the store's chunk shape.
 */
export async function loadBlock(
  reader: ChunkReader,
  variable: CubeVariable,
  box: Box,
  index: number,
  timeChunk: number,
  totalMonths: number,
  tileSize: { latitude: number; longitude: number },
  onProgress?: (progress: BlockProgress) => void,
  concurrency = 8,
): Promise<Block> {
  const start = index * timeChunk;
  const months = Math.min(timeChunk, totalMonths - start);
  const rows = box.lat.index.length;
  const cols = box.lon.index.length;
  const levels = box.depth.length;
  const codes = new Int16Array(months * levels * rows * cols).fill(MISSING);
  const at = cellOffset(box);
  const tasks: Array<() => Promise<void>> = [];
  let done = 0;
  const total = levels * box.tiles.length;
  for (let k = 0; k < levels; k++) {
    for (const [tileLat, tileLon] of box.tiles) {
      tasks.push(async () => {
        const result = await reader.fetchChunkResult(variable.name, [
          index,
          k,
          tileLat,
          tileLon,
        ]);
        const data = result.data;
        for (let r = 0; r < rows; r++) {
          if (box.lat.chunk[r] !== tileLat) {
            continue;
          }
          const y = box.lat.offset[r];
          for (let c = 0; c < cols; c++) {
            if (box.lon.chunk[c] !== tileLon) {
              continue;
            }
            const x = box.lon.offset[c];
            for (let m = 0; m < months; m++) {
              // The chunk holds one level: [time][1][lat][lon].
              const value =
                data[(m * tileSize.latitude + y) * tileSize.longitude + x];
              codes[at(m, k, r, c)] = Number.isNaN(value)
                ? MISSING
                : Math.round(value / variable.scale);
            }
          }
        }
        done++;
        onProgress?.({ index, done, total });
      });
    }
  }
  await pooled(tasks, concurrency);
  return { index, start, months, scale: variable.scale, codes };
}

/** A month of a block, resampled on the regular depth grid. */
export interface Volume {
  cols: number;
  rows: number;
  steps: number;
  /** °C in [step][lat][lon] order; NaN where missing. */
  values: Float32Array;
  /** Departure from the 1991–2020 climatology, same layout, when the anomaly is shown. */
  anomaly?: Float32Array;
}

/**
 * Resamples month `m` of a block onto `steps` depths from 0 to `bottom` m,
 * with the same month of an anomaly block when given (both blocks share the time chunk).
 * `weights` can be shared between calls (see depthWeights).
 */
export function monthVolume(
  block: Block,
  box: Box,
  m: number,
  steps: number,
  bottom: number,
  weights = depthWeights(box.depth, steps, bottom),
  anomaly?: Block,
): Volume {
  return {
    cols: box.lon.index.length,
    rows: box.lat.index.length,
    steps,
    values: resample(block, box, m, steps, weights),
    ...(anomaly ? { anomaly: resample(anomaly, box, m, steps, weights) } : {}),
  };
}

/** Month `m` of a block on `steps` depths, in [step][lat][lon] order. */
function resample(
  block: Block,
  box: Box,
  m: number,
  steps: number,
  weights: ReturnType<typeof depthWeights>,
): Float32Array {
  const plane = box.lat.index.length * box.lon.index.length;
  const levels = box.depth.length;
  const values = new Float32Array(steps * plane);
  const base = m * levels * plane;
  const decode = (code: number) =>
    code === MISSING ? NaN : code * block.scale;
  for (let step = 0; step < steps; step++) {
    const upper = base + weights.upper[step] * plane;
    const lower = base + weights.lower[step] * plane;
    const weight = weights.weight[step];
    const out = step * plane;
    for (let i = 0; i < plane; i++) {
      values[out + i] = interpolate(
        decode(block.codes[upper + i]),
        decode(block.codes[lower + i]),
        weight,
      );
    }
  }
  return values;
}

/** Keeps the most recently used blocks and loads each one once. */
export class BlockCache {
  private blocks = new Map<number, Block>();
  private pending = new Map<number, Promise<Block>>();

  constructor(
    private readonly load: (index: number) => Promise<Block>,
    private readonly capacity = 3,
  ) {}

  has(index: number): boolean {
    return this.blocks.has(index);
  }

  peek(index: number): Block | undefined {
    const block = this.blocks.get(index);
    if (block) {
      this.blocks.delete(index);
      this.blocks.set(index, block);
    }
    return block;
  }

  loading(index: number): boolean {
    return this.pending.has(index);
  }

  get(index: number): Promise<Block> {
    const block = this.peek(index);
    if (block) {
      return Promise.resolve(block);
    }
    let promise = this.pending.get(index);
    if (!promise) {
      promise = this.load(index)
        .then((loaded) => {
          this.blocks.set(index, loaded);
          while (this.blocks.size > this.capacity) {
            this.blocks.delete(this.blocks.keys().next().value!);
          }
          return loaded;
        })
        .finally(() => this.pending.delete(index));
      this.pending.set(index, promise);
    }
    return promise;
  }

  /** Indices of the blocks in memory. */
  loaded(): number[] {
    return [...this.blocks.keys()];
  }
}
