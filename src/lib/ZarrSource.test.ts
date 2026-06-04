import { afterEach, describe, expect, it, vi } from "vitest";
import { ZarrSource } from "./ZarrSource";

const root = "https://example.test/zarr";

function zarray(shape: number[], chunks: number[], order = "C", dtype = "<f4") {
  return {
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: null,
    fill_value: null,
    order,
    filters: null,
  };
}

function attrs(dimensions: string[], extra: Record<string, unknown> = {}) {
  return {
    _ARRAY_DIMENSIONS: dimensions,
    ...extra,
  };
}

function chunk(values: number[]) {
  const bytes = new Float32Array(values);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function chunkFloat64(values: number[]) {
  const bytes = new Float64Array(values);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function response(body: unknown, ok = true, status = ok ? 200 : 404): Response {
  return {
    ok,
    status,
    json: async () => body,
    arrayBuffer: async () => body as ArrayBuffer,
  } as Response;
}

function installFetch(routes: Record<string, Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    const res = routes[url];
    if (!res) return response(new ArrayBuffer(0), false, 404);
    return res;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function baseRoutes(extra: Record<string, Response> = {}) {
  const metadata = {
    zarr_consolidated_format: 1,
    metadata: {
      "time/.zarray": zarray([4], [4]),
      "time/.zattrs": attrs(["time"], {
        units: "hours since 2020-01-01T00:00:00Z",
      }),
      "latitude/.zarray": zarray([3], [3]),
      "latitude/.zattrs": attrs(["latitude"]),
      "longitude/.zarray": zarray([4], [4]),
      "longitude/.zattrs": attrs(["longitude"]),
      "depth/.zarray": zarray([3], [3]),
      "depth/.zattrs": attrs(["depth"]),
      "u/.zarray": zarray([4, 3, 3, 4], [1, 1, 3, 4]),
      "u/.zattrs": attrs(["time", "depth", "latitude", "longitude"]),
      "v/.zarray": zarray([4, 3, 3, 4], [1, 1, 3, 4]),
      "v/.zattrs": attrs(["time", "depth", "latitude", "longitude"]),
    },
  };

  return {
    [`${root}/.zmetadata`]: response(metadata),
    [`${root}/time/0`]: response(chunk([0, 6, 12, 18])),
    [`${root}/latitude/0`]: response(chunk([10, 20, 30])),
    [`${root}/longitude/0`]: response(chunk([-170, -10, 10, 170])),
    [`${root}/depth/0`]: response(chunk([0, 100, 200])),
    ...extra,
  };
}

function dataValue(timeIdx: number, depthIdx: number, latIdx: number, lonIdx: number) {
  return timeIdx * 1000 + depthIdx * 100 + latIdx * 10 + lonIdx;
}

function dataChunk(timeIdx: number, depthIdx: number, multiplier = 1) {
  const values: number[] = [];
  for (let latIdx = 0; latIdx < 3; latIdx++) {
    for (let lonIdx = 0; lonIdx < 4; lonIdx++) {
      values.push(dataValue(timeIdx, depthIdx, latIdx, lonIdx) * multiplier);
    }
  }
  return response(chunk(values));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ZarrSource point sampling", () => {
  it("exposes time dimension metadata in Unix milliseconds", async () => {
    installFetch(baseRoutes());

    const source = new ZarrSource(root);
    await source.init();

    expect(source.getTimeDimension()).toEqual({
      min: Date.UTC(2020, 0, 1, 0),
      max: Date.UTC(2020, 0, 1, 18),
      step: 6 * 60 * 60 * 1000,
      size: 4,
      units: "hours since 2020-01-01T00:00:00Z",
    });
  });

  it("preserves epoch-millisecond f8 time coordinate precision", async () => {
    const start = Date.UTC(2026, 5, 1, 0);
    const metadata = {
      zarr_consolidated_format: 1,
      metadata: {
        "time/.zarray": zarray([3], [3], "C", "<f8"),
        "time/.zattrs": attrs(["time"], {
          units: "milliseconds since 1970-01-01T00:00:00Z",
        }),
        "latitude/.zarray": zarray([1], [1]),
        "latitude/.zattrs": attrs(["latitude"]),
        "longitude/.zarray": zarray([1], [1]),
        "longitude/.zattrs": attrs(["longitude"]),
      },
    };

    installFetch({
      [`${root}/.zmetadata`]: response(metadata),
      [`${root}/time/0`]: response(
        chunkFloat64([start, start + 3600000, start + 7200000]),
      ),
      [`${root}/latitude/0`]: response(chunk([0])),
      [`${root}/longitude/0`]: response(chunk([0])),
    });

    const source = new ZarrSource(root);
    await source.init();

    expect(source.getCoords().time).toBeInstanceOf(Float64Array);
    expect(source.getTimeDimension()).toEqual({
      min: start,
      max: start + 7200000,
      step: 3600000,
      size: 3,
      units: "milliseconds since 1970-01-01T00:00:00Z",
    });
  });

  it("samples a time series at the nearest lon/lat/depth grid point", async () => {
    installFetch(baseRoutes({
      [`${root}/u/0.1.0.0`]: dataChunk(0, 1),
      [`${root}/u/1.1.0.0`]: dataChunk(1, 1),
      [`${root}/u/2.1.0.0`]: dataChunk(2, 1),
    }));

    const source = new ZarrSource(root);
    const result = await source.sampleTimeSeries({
      variables: ["u"],
      longitude: -12,
      latitude: 18,
      depth: 90,
      timeStartIndex: 0,
      timeEndIndex: 2,
    });

    expect(result.longitude).toBe(-10);
    expect(result.latitude).toBe(20);
    expect(result.depth).toBe(100);
    expect(result.points.map((p) => p.time)).toEqual([
      Date.UTC(2020, 0, 1, 0),
      Date.UTC(2020, 0, 1, 6),
      Date.UTC(2020, 0, 1, 12),
    ]);
    expect(result.points.map((p) => p.values.u)).toEqual([111, 1111, 2111]);
  });

  it("normalizes wrapped longitudes before sampling", async () => {
    installFetch(baseRoutes({
      [`${root}/u/0.0.0.0`]: dataChunk(0, 0),
    }));

    const source = new ZarrSource(root);
    const result = await source.sampleTimeSeries({
      variables: ["u"],
      longitude: 190,
      latitude: 21,
      timeStartIndex: 0,
      timeEndIndex: 0,
    });

    expect(result.longitude).toBe(-170);
    expect(result.points[0].values.u).toBe(10);
  });

  it("samples a vertical profile at the nearest time and location", async () => {
    installFetch(baseRoutes({
      [`${root}/u/1.0.0.0`]: dataChunk(1, 0),
      [`${root}/u/1.1.0.0`]: dataChunk(1, 1),
      [`${root}/u/1.2.0.0`]: dataChunk(1, 2),
    }));

    const source = new ZarrSource(root);
    const result = await source.sampleVerticalProfile({
      variables: ["u"],
      longitude: 9,
      latitude: 29,
      time: Date.UTC(2020, 0, 1, 7),
    });

    expect(result.time).toBe(Date.UTC(2020, 0, 1, 6));
    expect(result.points.map((p) => p.depth)).toEqual([0, 100, 200]);
    expect(result.points.map((p) => p.values.u)).toEqual([1022, 1122, 1222]);
  });

  it("converts missing point chunks to NaN without hiding other variables", async () => {
    installFetch(baseRoutes({
      [`${root}/u/0.0.0.0`]: response(new ArrayBuffer(0), false, 403),
      [`${root}/v/0.0.0.0`]: dataChunk(0, 0, -1),
    }));

    const source = new ZarrSource(root);
    const result = await source.sampleTimeSeries({
      variables: ["u", "v"],
      longitude: 11,
      latitude: 20,
      timeStartIndex: 0,
      timeEndIndex: 0,
    });

    expect(result.points[0].values.u).toBeNaN();
    expect(result.points[0].values.v).toBe(-12);
  });

  it("stops after a configured run of all-missing samples", async () => {
    installFetch(baseRoutes({
      [`${root}/u/0.0.0.0`]: response(new ArrayBuffer(0), false, 403),
      [`${root}/u/1.0.0.0`]: response(new ArrayBuffer(0), false, 403),
      [`${root}/u/2.0.0.0`]: dataChunk(2, 0),
    }));

    const source = new ZarrSource(root);
    const result = await source.sampleTimeSeries({
      variables: ["u"],
      longitude: 11,
      latitude: 20,
      timeStartIndex: 0,
      timeEndIndex: 2,
      stopAfterMissingSamples: 2,
    });

    expect(result.points).toHaveLength(2);
    expect(result.points.every((p) => Number.isNaN(p.values.u))).toBe(true);
  });
});
