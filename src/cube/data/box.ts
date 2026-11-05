/**
 * The data cube: which cells of the GODAS grid it holds and where they sit in
 * the store's chunks. Longitudes are unwrapped east of 0 (120…280), so the box
 * crosses the date line without a break.
 */

/** West, east (unwrapped, degrees east), south, north and deepest level of the cube. */
export interface BoxSpec {
  west: number;
  east: number;
  south: number;
  north: number;
  maxDepth: number;
}

/**
 * 120° E–80° W, 14.5° S–15° N, 0–303 m. The south and depth limits follow the
 * point-series tiles of 60 × 60 cells: one more southern row would need a
 * third row of tiles. The band covers the equatorial signal of ENSO (±5°)
 * and the 20 °C isotherm, which stays above ~270 m in the box.
 */
export const PACIFIC_BOX: BoxSpec = {
  west: 120,
  east: 280,
  south: -14.5,
  north: 15,
  maxDepth: 305,
};

/** The Niño 3.4 region, 170° W–120° W, 5° S–5° N, unwrapped. */
export const NINO34 = { west: 190, east: 240, south: -5, north: 5 } as const;

/** One axis of the cube: store indices, their chunk and offset, and their coordinate. */
export interface Axis {
  index: Int32Array;
  chunk: Int32Array;
  offset: Int32Array;
  value: Float64Array;
}

export interface Box {
  spec: BoxSpec;
  lon: Axis;
  lat: Axis;
  /** Depth levels kept, shallow to deep; depth[k] in metres. */
  depth: Float64Array;
  /** Distinct (lat chunk, lon chunk) pairs to fetch for one level. */
  tiles: Array<[number, number]>;
}

/** Longitude east of 0, so 120…280 is one interval. */
export function unwrap(longitude: number): number {
  return longitude < 0 ? longitude + 360 : longitude;
}

/** Back to −180…180, for labels. */
export function wrap(longitude: number): number {
  return longitude > 180 ? longitude - 360 : longitude;
}

const EPSILON = 1e-3;

function axis(
  coords: ArrayLike<number>,
  keep: (value: number) => number | null,
  chunkSize: number,
): Axis {
  const picked: Array<[number, number]> = [];
  for (let i = 0; i < coords.length; i++) {
    const value = keep(coords[i]);
    if (value !== null) {
      picked.push([value, i]);
    }
  }
  picked.sort((a, b) => a[0] - b[0]);
  return {
    index: Int32Array.from(picked, ([, i]) => i),
    chunk: Int32Array.from(picked, ([, i]) => Math.floor(i / chunkSize)),
    offset: Int32Array.from(picked, ([, i]) => i % chunkSize),
    value: Float64Array.from(picked, ([value]) => value),
  };
}

/** The cube's cells in a store with these coordinates and (lat, lon) chunk sizes. */
export function createBox(
  coords: {
    longitude: ArrayLike<number>;
    latitude: ArrayLike<number>;
    depth: ArrayLike<number>;
  },
  chunks: { latitude: number; longitude: number },
  spec: BoxSpec = PACIFIC_BOX,
): Box {
  const lon = axis(
    coords.longitude,
    (value) => {
      const east = unwrap(value);
      return east >= spec.west - EPSILON && east <= spec.east + EPSILON
        ? east
        : null;
    },
    chunks.longitude,
  );
  const lat = axis(
    coords.latitude,
    (value) =>
      value >= spec.south - EPSILON && value <= spec.north + EPSILON
        ? value
        : null,
    chunks.latitude,
  );
  const depth = Float64Array.from(
    Array.from(coords.depth).filter((value) => value <= spec.maxDepth),
  );
  const tiles: Array<[number, number]> = [];
  for (const y of new Set(lat.chunk)) {
    for (const x of new Set(lon.chunk)) {
      tiles.push([y, x]);
    }
  }
  return { spec, lon, lat, depth, tiles };
}

/** Indices of an axis whose values fall in [low, high]. */
export function within(axis: Axis, low: number, high: number): number[] {
  const result: number[] = [];
  axis.value.forEach((value, i) => {
    if (value >= low - EPSILON && value <= high + EPSILON) {
      result.push(i);
    }
  });
  return result;
}

/** "160° W", "120° E", "0°" for an unwrapped longitude. */
export function lonLabel(longitude: number, digits = 0): string {
  const value = wrap(longitude);
  const text = Math.abs(value).toFixed(digits);
  if (Math.abs(value) < 1e-6 || Math.abs(Math.abs(value) - 180) < 1e-6) {
    return `${text}°`;
  }
  return `${text}° ${value < 0 ? "W" : "E"}`;
}

/** "5° S", "0°", "10° N". */
export function latLabel(latitude: number, digits = 0): string {
  const text = Math.abs(latitude).toFixed(digits);
  if (Math.abs(latitude) < 1e-6) {
    return `${text}°`;
  }
  return `${text}° ${latitude < 0 ? "S" : "N"}`;
}
