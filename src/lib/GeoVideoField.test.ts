import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeoVideoField, velocityTexels } from "./GeoVideoField";
import { timeBracket } from "./time-bracket";

import { GeoVideoScalarSource } from "./GeoVideoScalarSource";
import { geoVideoTimelineValues } from "./geovideo";
import {
  deferred,
  flushFrames,
  geoVideoTestGl,
  scalarManifest,
} from "./test-geovideo";

describe("field texels", () => {
  it("packs vector components as (u, v, validity, 0)", () => {
    const texels = velocityTexels({
      u: new Float32Array([0.5, NaN]),
      v: new Float32Array([-0.25, 1]),
    });
    expect(Array.from(texels)).toEqual([0.5, -0.25, 1, 0, 0, 0, 0, 0]);
  });
});

describe("timeBracket", () => {
  it("finds the step at or before a time and the fraction to the next", () => {
    expect(timeBracket([0, 10, 20], 15)).toEqual({ index: 1, fraction: 0.5 });
    expect(timeBracket([0, 10, 20], -5)).toEqual({ index: 0, fraction: 0 });
    expect(timeBracket([0, 10, 20], 25)).toEqual({ index: 2, fraction: 0 });
  });
});

const times = geoVideoTimelineValues(scalarManifest);
const bitmap = {} as ImageBitmap;
beforeEach(() => {
  vi.spyOn(GeoVideoScalarSource.prototype, "frame").mockResolvedValue(bitmap);
  vi.spyOn(GeoVideoScalarSource.prototype, "mask", "get").mockReturnValue(
    new Uint8Array(128).fill(255),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fieldAtStart() {
  const { gl, calls } = geoVideoTestGl();
  const field = new GeoVideoField(gl, scalarManifest, {
    repeatLongitude: false,
  });
  await field.prime(times[0]);
  field.sample(times[0]);
  await flushFrames();
  return { field, calls, gl };
}

describe("GeoVideoField texture cache", () => {
  it("uploads each decoded step once and blends the surrounding textures", async () => {
    const { field } = await fieldAtStart();
    const pair = field.sample((times[0] + times[1]) / 2)!;
    expect(pair[0]).not.toBe(pair[1]);
    expect(pair[2]).toBe(0.5);
    await field.prime(times[0]);
    expect(
      vi
        .mocked(GeoVideoScalarSource.prototype.frame)
        .mock.calls.filter(([i]) => i === 0),
    ).toHaveLength(1);
    expect(field.sample((times[0] + times[1]) / 2, false)).toEqual([
      pair[0],
      pair[0],
      0,
    ]);
  });

  it("retains the last complete pair when either new texture is missing", async () => {
    const { field } = await fieldAtStart();
    const previous = field.sample((times[0] + times[1]) / 2);
    const pending = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockImplementation(
      (index) => (index === 5 ? pending.promise : Promise.resolve(bitmap)),
    );
    field.sample((times[4] + times[5]) / 2);
    await flushFrames();
    expect(field.sample((times[4] + times[5]) / 2)).toBe(previous);
    pending.resolve(bitmap);
    await flushFrames();
    const pair = field.sample((times[4] + times[5]) / 2)!;
    expect(pair).not.toBe(previous);
    expect(pair[2]).toBe(0.5);
  });

  it("evicts around the playhead but pins the pair still on screen", async () => {
    const { field, calls } = await fieldAtStart();
    const previous = field.sample((times[0] + times[1]) / 2)!;
    const pending = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockReturnValue(
      pending.promise,
    );
    field.sample(times[8]);
    expect(calls.deleteTexture).not.toHaveBeenCalledWith(previous[0]);
    expect(calls.deleteTexture).not.toHaveBeenCalledWith(previous[1]);
    pending.resolve(bitmap);
    await flushFrames();
    field.sample(times[8]);
    expect(calls.deleteTexture).toHaveBeenCalledWith(previous[0]);
    expect(calls.deleteTexture).toHaveBeenCalledWith(previous[1]);
    expect(field.cachedFrames).toBeLessThanOrEqual(5);
  });

  it("discards stale queued uploads after focusing another step", async () => {
    const { field } = await fieldAtStart();
    const pending = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockReturnValue(
      pending.promise,
    );
    field.focus(times[7]);
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockResolvedValue(bitmap);
    field.focus(times[4]);
    await field.prime(times[4]);
    pending.resolve(bitmap);
    await flushFrames();
    expect(field.ready(times[4])).toBe(true);
    expect(field.ready(times[7])).toBe(false);
  });

  it("does not upload after destruction and frees every texture", async () => {
    const { field, calls } = await fieldAtStart();
    const pending = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockReturnValue(
      pending.promise,
    );
    field.focus(times[8]);
    const count = field.cachedFrames;
    field.destroy();
    pending.resolve(bitmap);
    await flushFrames();
    expect(calls.deleteTexture).toHaveBeenCalledTimes(count + 1);
    expect(field.cachedFrames).toBe(0);
    expect(field.currentPair).toBeNull();
  });

  it("restores texture and pixel unpack state after asynchronous uploads", async () => {
    const { gl, calls } = geoVideoTestGl();
    const binding = {};
    const values = new Map<number, unknown>([
      [gl.TEXTURE_BINDING_2D, binding],
      [gl.UNPACK_FLIP_Y_WEBGL, true],
      [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true],
      [gl.UNPACK_ALIGNMENT, 8],
      [gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL],
    ]);
    calls.getParameter.mockImplementation((name) => values.get(name));
    const field = new GeoVideoField(gl, scalarManifest, {
      repeatLongitude: false,
    });
    await field.prime(times[0]);
    expect(calls.bindTexture).toHaveBeenLastCalledWith(gl.TEXTURE_2D, binding);
    for (const [key, value] of values) {
      if (key !== gl.TEXTURE_BINDING_2D) {
        expect(calls.pixelStorei).toHaveBeenCalledWith(key, value);
      }
    }
    expect(field.maskTexture).not.toBeNull();
  });
});
