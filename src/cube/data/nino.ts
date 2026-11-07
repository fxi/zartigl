/**
 * A Niño 3.4 index from GODAS itself: the cos(latitude)-weighted mean of the
 * first level (5 m) over 170° W–120° W, 5° S–5° N, as an anomaly from its
 * 1991–2020 monthly climatology, smoothed over three months. Close to NOAA's
 * ONI in timing and sign, but not the official index (which uses ERSST).
 */

import { NINO34, unwrap } from "./box";
import type { ChunkReader } from "./blocks";
import { POTTMP } from "./blocks";

export const BASE_PERIOD: [number, number] = [1991, 2020];
/** ONI-style thresholds, °C, held for at least five overlapping seasons. */
export const THRESHOLD = 0.5;
export const MIN_RUN = 5;

interface Cell {
  y: number;
  x: number;
  weight: number;
}

/** The Niño 3.4 cells of one chunk, with their area weights. */
function ninoCells(
  latitude: ArrayLike<number>,
  longitude: ArrayLike<number>,
  tile: { latitude: number; longitude: number },
): Map<string, Cell[]> {
  const tiles = new Map<string, Cell[]>();
  for (let i = 0; i < latitude.length; i++) {
    const lat = latitude[i];
    if (lat < NINO34.south - 1e-3 || lat > NINO34.north + 1e-3) {
      continue;
    }
    for (let j = 0; j < longitude.length; j++) {
      const lon = unwrap(longitude[j]);
      if (lon < NINO34.west - 1e-3 || lon > NINO34.east + 1e-3) {
        continue;
      }
      const key = `${Math.floor(i / tile.latitude)}.${Math.floor(j / tile.longitude)}`;
      const cells = tiles.get(key) ?? [];
      cells.push({
        y: i % tile.latitude,
        x: j % tile.longitude,
        weight: Math.cos((lat * Math.PI) / 180),
      });
      tiles.set(key, cells);
    }
  }
  return tiles;
}

/** The monthly Niño 3.4 box mean at 5 m, every month of the store. */
export async function ninoSeries(
  reader: ChunkReader,
  coords: { latitude: ArrayLike<number>; longitude: ArrayLike<number> },
  totalMonths: number,
  timeChunk: number,
  tile: { latitude: number; longitude: number },
): Promise<Float64Array> {
  const tiles = ninoCells(coords.latitude, coords.longitude, tile);
  const sums = new Float64Array(totalMonths);
  const weights = new Float64Array(totalMonths);
  const blocks = Math.ceil(totalMonths / timeChunk);
  const tasks: Promise<void>[] = [];
  for (let b = 0; b < blocks; b++) {
    for (const [key, cells] of tiles) {
      const [y, x] = key.split(".").map(Number);
      tasks.push(
        reader.fetchChunkResult(POTTMP.name, [b, 0, y, x]).then(({ data }) => {
          const months = Math.min(timeChunk, totalMonths - b * timeChunk);
          for (let m = 0; m < months; m++) {
            for (const cell of cells) {
              const value =
                data[(m * tile.latitude + cell.y) * tile.longitude + cell.x];
              if (!Number.isNaN(value)) {
                sums[b * timeChunk + m] += value * cell.weight;
                weights[b * timeChunk + m] += cell.weight;
              }
            }
          }
        }),
      );
    }
  }
  await Promise.all(tasks);
  return sums.map((sum, i) => (weights[i] > 0 ? sum / weights[i] : NaN));
}

/** Calendar month (0–11) and year of epoch milliseconds. */
function yearMonth(ms: number): [number, number] {
  const date = new Date(ms);
  return [date.getUTCFullYear(), date.getUTCMonth()];
}

/** Mean of each calendar month over the base period. */
export function climatology(
  series: ArrayLike<number>,
  times: ArrayLike<number>,
  base: [number, number] = BASE_PERIOD,
): Float64Array {
  const sums = new Float64Array(12);
  const counts = new Float64Array(12);
  for (let i = 0; i < series.length; i++) {
    const [year, month] = yearMonth(times[i]);
    if (year >= base[0] && year <= base[1] && !Number.isNaN(series[i])) {
      sums[month] += series[i];
      counts[month]++;
    }
  }
  return sums.map((sum, month) => (counts[month] ? sum / counts[month] : NaN));
}

/** Departure of each month from its calendar-month climatology. */
export function anomaly(
  series: ArrayLike<number>,
  times: ArrayLike<number>,
  normals: ArrayLike<number>,
): Float64Array {
  return Float64Array.from(
    series,
    (value, i) => value - normals[yearMonth(times[i])[1]],
  );
}

/** Centred three-month mean; the first and last months average what they have. */
export function runningMean(series: ArrayLike<number>): Float64Array {
  return Float64Array.from(series, (_, i) => {
    let sum = 0;
    let count = 0;
    for (
      let j = Math.max(0, i - 1);
      j <= Math.min(series.length - 1, i + 1);
      j++
    ) {
      if (!Number.isNaN(series[j])) {
        sum += series[j];
        count++;
      }
    }
    return count ? sum / count : NaN;
  });
}

export type Phase = "el-nino" | "la-nina";

export interface Episode {
  phase: Phase;
  /** First and last month, indices on the series. */
  start: number;
  end: number;
  /** Strongest smoothed anomaly, °C. */
  peak: number;
}

/** Runs of at least `MIN_RUN` months at or beyond ±`THRESHOLD`. */
export function episodes(index: ArrayLike<number>): Episode[] {
  const found: Episode[] = [];
  let current: Episode | null = null;
  const close = () => {
    if (current && current.end - current.start + 1 >= MIN_RUN) {
      found.push(current);
    }
    current = null;
  };
  for (let i = 0; i < index.length; i++) {
    const value = index[i];
    const phase: Phase | null =
      value >= THRESHOLD ? "el-nino" : value <= -THRESHOLD ? "la-nina" : null;
    if (current && current.phase === phase) {
      current.end = i;
      if (Math.abs(value) > Math.abs(current.peak)) {
        current.peak = value;
      }
      continue;
    }
    close();
    if (phase) {
      current = { phase, start: i, end: i, peak: value };
    }
  }
  close();
  return found;
}
