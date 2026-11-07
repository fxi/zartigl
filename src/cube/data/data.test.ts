import { describe, expect, it } from "vitest";
import { createBox, latLabel, lonLabel, unwrap, within } from "./box";
import {
  BlockCache,
  MISSING,
  POTTMP,
  POTTMP_ANOM,
  loadBlock,
  monthVolume,
} from "./blocks";
import { depthWeights } from "./depth";
import {
  anomaly,
  climatology,
  episodes,
  ninoSeries,
  runningMean,
} from "./nino";

// The GODAS grid: 1° in longitude from −179.5, 1/3° in latitude from −74.5.
const LONGITUDE = Array.from({ length: 360 }, (_, i) => -179.5 + i);
const LATITUDE = Array.from({ length: 418 }, (_, i) => -74.5 + i / 3);
const DEPTH = [
  5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175,
  185, 195, 205, 215, 225, 238, 262, 303, 366, 459,
];
const TILE = { latitude: 60, longitude: 60 };

function months(count: number, from = 1980): number[] {
  return Array.from({ length: count }, (_, i) =>
    Date.UTC(from + Math.floor(i / 12), i % 12, 1),
  );
}

describe("box", () => {
  const box = createBox(
    { longitude: LONGITUDE, latitude: LATITUDE, depth: DEPTH },
    TILE,
  );

  it("crosses the date line in one unwrapped run", () => {
    expect(box.lon.value.length).toBe(160);
    expect(box.lon.value[0]).toBe(120.5);
    expect(box.lon.value[159]).toBe(279.5);
    // 179.5° E then 179.5° W (store index 0), next to each other.
    const east = box.lon.value.indexOf(179.5);
    expect(box.lon.value[east + 1]).toBe(180.5);
    expect(box.lon.index[east + 1]).toBe(0);
  });

  it("keeps two rows and three columns of tiles and the levels to 303 m", () => {
    expect(box.lat.value[0]).toBeCloseTo(-14.5, 6);
    expect(box.lat.value[box.lat.value.length - 1]).toBeLessThanOrEqual(15);
    expect(box.lat.value.length).toBe(89);
    expect(new Set(box.lat.chunk)).toEqual(new Set([3, 4]));
    expect(new Set(box.lon.chunk)).toEqual(new Set([5, 0, 1]));
    expect(box.tiles).toHaveLength(6);
    expect(box.depth[box.depth.length - 1]).toBe(303);
  });

  it("selects and labels positions", () => {
    expect(within(box.lat, -5, 5)).toHaveLength(30);
    expect(lonLabel(unwrap(-170))).toBe("170° W");
    expect(lonLabel(180)).toBe("180°");
    expect(latLabel(-5)).toBe("5° S");
  });
});

describe("depth resampling", () => {
  it("interpolates between level centres and clamps above the first", () => {
    const weights = depthWeights([5, 15, 25], 4, 30);
    // Grid depths 0, 10, 20, 30.
    expect(Array.from(weights.upper)).toEqual([0, 0, 1, 2]);
    expect(Array.from(weights.lower)).toEqual([0, 1, 2, 2]);
    expect(weights.weight[1]).toBeCloseTo(0.5);
  });
});

describe("blocks", () => {
  const box = createBox(
    { longitude: LONGITUDE, latitude: LATITUDE, depth: DEPTH.slice(0, 3) },
    TILE,
  );

  it("copies each tile into the box and marks missing cells", async () => {
    const requested: number[][] = [];
    const reader = {
      fetchChunkResult: async (_variable: string, indices: number[]) => {
        requested.push(indices);
        const [, level, y, x] = indices;
        const data = new Float32Array(60 * 60 * 60).fill(10 + level);
        // Month 1, first cell of tile (3, 5): land.
        if (y === 3 && x === 5) {
          data[1 * 3600] = NaN;
        }
        return { data, missing: false, url: "" };
      },
    };
    const block = await loadBlock(reader, POTTMP, box, 2, 60, 130, TILE);
    expect(block.start).toBe(120);
    expect(block.months).toBe(10);
    expect(requested).toHaveLength(3 * 6);
    expect(requested.every((indices) => indices[0] === 2)).toBe(true);
    const volume = monthVolume(block, box, 0, 3, 25);
    // Depth 0 m uses the 5 m level, 12.5 m is between 5 and 15 m.
    expect(volume.values[0]).toBeCloseTo(10);
    expect(volume.values[volume.cols * volume.rows]).toBeCloseTo(10.75, 2);
    const land = monthVolume(block, box, 1, 3, 25);
    // Row 0 (lat −14.5, tile 3) and column 0 (120.5° E, tile 5) is the cell set to NaN.
    expect(land.values[0]).toBeNaN();
    expect(block.codes[0]).toBe(Math.round(10 / POTTMP.scale));
    expect(MISSING).toBe(-32768);
    expect(volume.anomaly).toBeUndefined();
  });

  it("reads the anomaly at its own precision, beside the absolute month", async () => {
    const requested: string[] = [];
    const reader = {
      fetchChunkResult: async (variable: string, indices: number[]) => {
        requested.push(variable);
        const anomaly = variable === POTTMP_ANOM.name;
        const value = anomaly ? 1.2345 + indices[1] : 20 + indices[1];
        const data = new Float32Array(60 * 60 * 60).fill(value);
        return { data, missing: false, url: "" };
      },
    };
    const block = await loadBlock(reader, POTTMP, box, 0, 60, 130, TILE);
    const departures = await loadBlock(
      reader,
      POTTMP_ANOM,
      box,
      0,
      60,
      130,
      TILE,
    );
    expect(new Set(requested)).toEqual(new Set(["pottmp", "pottmp_anom"]));
    expect(departures.scale).toBe(0.001);
    const volume = monthVolume(block, box, 0, 3, 25, undefined, departures);
    expect(volume.values[0]).toBeCloseTo(20, 3);
    // 0.001 °C codes keep the third decimal the 0.002 °C ones would round.
    expect(volume.anomaly![0]).toBeCloseTo(1.235, 3);
    expect(volume.anomaly!.length).toBe(volume.values.length);
  });

  it("loads a block once and keeps the most recent ones", async () => {
    let loads = 0;
    const cache = new BlockCache(async (index) => {
      loads++;
      return {
        index,
        start: 0,
        months: 0,
        scale: 0.002,
        codes: new Int16Array(),
      };
    }, 2);
    await Promise.all([cache.get(0), cache.get(0)]);
    await cache.get(1);
    await cache.get(2);
    expect(loads).toBe(3);
    expect(cache.loaded()).toEqual([1, 2]);
  });
});

describe("Niño 3.4", () => {
  it("averages the box at 5 m over every block", async () => {
    const reader = {
      fetchChunkResult: async (_variable: string, indices: number[]) => {
        expect(indices[1]).toBe(0);
        expect([indices[2], indices[3]]).toEqual([3, 0]);
        return {
          data: new Float32Array(60 * 3600).fill(27 + indices[0]),
          missing: false,
          url: "",
        };
      },
    };
    const series = await ninoSeries(
      reader,
      { latitude: LATITUDE, longitude: LONGITUDE },
      70,
      60,
      TILE,
    );
    expect(series[0]).toBeCloseTo(27);
    expect(series[69]).toBeCloseTo(28);
  });

  it("finds warm and cold episodes from the base-period anomaly", () => {
    const times = months(12 * 45);
    const series = times.map((ms, i) => {
      const month = new Date(ms).getUTCMonth();
      const seasonal = 27 + Math.sin((month / 12) * 2 * Math.PI);
      // A warm event in 1997-06…1998-03, a cold one in 2010-07…2011-02.
      const year = 1980 + Math.floor(i / 12);
      const warm =
        (year === 1997 && month >= 5) || (year === 1998 && month <= 2) ? 2 : 0;
      const cold =
        (year === 2010 && month >= 6) || (year === 2011 && month <= 1)
          ? -1.5
          : 0;
      return seasonal + warm + cold;
    });
    const normals = climatology(series, times);
    const index = runningMean(anomaly(series, times, normals));
    const found = episodes(index);
    expect(found.map((episode) => episode.phase)).toEqual([
      "el-nino",
      "la-nina",
    ]);
    expect(new Date(times[found[0].start]).getUTCFullYear()).toBe(1997);
    expect(found[0].peak).toBeGreaterThan(1.5);
  });
});
