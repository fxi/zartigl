import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeoVideoLayer, type GeoVideoLayerOptions } from "./GeoVideoLayer";
import { GeoVideoScalarSource } from "./GeoVideoScalarSource";
import { geoVideoTimelineValues, type GeoVideoManifest } from "./geovideo";
import {
  deferred,
  flushFrames,
  geoVideoTestGl,
  scalarManifest,
} from "./test-geovideo";

vi.mock("./gl-util", async (original) => ({
  ...(await original<typeof import("./gl-util")>()),
  createProgram: vi.fn(() => ({})),
  createColorRampTexture: vi.fn(() => ({})),
}));

const times = geoVideoTimelineValues(scalarManifest);
const bitmap = {} as ImageBitmap;
const nextManifest: GeoVideoManifest = {
  ...scalarManifest,
  id: "next",
  media: { ...scalarManifest.media, url: "next.mp4" },
  mask: { ...scalarManifest.mask, url: "next-mask.png" },
  timeline: {
    kind: "sample-sequence",
    values: times.map((time) => new Date(time + 12 * 86400000).toISOString()),
  },
};

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

async function setup(options: Partial<GeoVideoLayerOptions> = {}) {
  const { gl, calls } = geoVideoTestGl();
  const map = {
    triggerRepaint: vi.fn(),
    getProjection: () => ({ type: "mercator" }),
    getZoom: () => 1,
    getBounds: () => ({ getWest: () => -180, getEast: () => 180 }),
  };
  const layer = new GeoVideoLayer({
    id: "test",
    manifest: scalarManifest,
    autoplay: false,
    playbackRate: 1 / 24,
    ...options,
  });
  const events = {
    loading: vi.fn(),
    loaded: vi.fn(),
    status: vi.fn(),
    error: vi.fn(),
    timeChange: vi.fn(),
    playbackChange: vi.fn(),
    playbackEnd: vi.fn(),
  };
  for (const [name, listener] of Object.entries(events)) {
    layer.on(name as keyof typeof events, listener);
  }
  await layer.onAdd(
    map as unknown as Parameters<GeoVideoLayer["onAdd"]>[0],
    gl,
  );
  await flushFrames();
  const render = (now: number) => {
    vi.spyOn(performance, "now").mockReturnValue(now);
    layer.render(gl, {
      modelViewProjectionMatrix: new Float32Array(16),
    } as unknown as Parameters<GeoVideoLayer["render"]>[1]);
  };
  return { layer, gl, calls, map, events, render };
}

describe("GeoVideoLayer decoded playback", () => {
  it("loads its initial clamped step and emits readiness after decoding", async () => {
    const { layer, events } = await setup({
      time: times[10],
      timeRange: [times[2], times[5]],
    });
    expect(GeoVideoScalarSource.prototype.frame).toHaveBeenCalledWith(5);
    expect(events.loading).toHaveBeenCalledOnce();
    expect(events.loaded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ time: new Date(times[5]).toISOString() }),
    );
    expect(layer.getDebugInfo().initialized).toBe(true);
  });

  it("blends on animation frames and reports time only once per step", async () => {
    const { layer, calls, events, render } = await setup();
    await layer.play();
    render(0);
    render(250);
    render(500);
    render(1000);
    render(1250);
    expect(calls.uniform1f).toHaveBeenCalledWith("u_mix", 0.25);
    expect(calls.uniform1f).toHaveBeenCalledWith("u_mix", 0.5);
    expect(events.timeChange.mock.calls).toEqual([[times[0]], [times[1]]]);
    expect(events.playbackChange.mock.calls).toEqual([[true]]);
  });

  it("supports rates below browser media limits and changes speed continuously", async () => {
    const { layer, calls, render } = await setup({ playbackRate: 0.01 / 24 });
    await layer.play();
    render(0);
    render(500);
    expect(calls.uniform1f).toHaveBeenCalledWith(
      "u_mix",
      expect.closeTo(0.005),
    );
    layer.setPlaybackRate(2 / 24);
    render(750);
    expect(calls.uniform1f).toHaveBeenCalledWith(
      "u_mix",
      expect.closeTo(0.505),
    );
  });

  it("pauses on an exact step and resumes without adding the paused interval", async () => {
    const { layer, calls, render } = await setup();
    await layer.play();
    render(0);
    render(500);
    layer.pause();
    await flushFrames();
    render(10000);
    expect(calls.uniform1f).toHaveBeenLastCalledWith(
      "u_world_offset",
      expect.any(Number),
    );
    expect(
      calls.uniform1f.mock.calls
        .filter(([name]) => name === "u_mix")
        .slice(-1)[0],
    ).toEqual(["u_mix", 0]);
    await layer.play();
    render(20000);
    render(20250);
    expect(
      calls.uniform1f.mock.calls
        .filter(([name]) => name === "u_mix")
        .slice(-1)[0],
    ).toEqual(["u_mix", 0.25]);
  });

  it("prioritizes a seek and keeps drawing the previous pair until it resolves", async () => {
    const { layer, calls, render } = await setup();
    render(0);
    const pending = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockImplementation(
      (index) => (index === 8 ? pending.promise : Promise.resolve(bitmap)),
    );
    layer.setTime(times[8]);
    render(100);
    expect(calls.drawElements).toHaveBeenCalledTimes(4);
    expect(layer.getDebugInfo().currentTime).toBeLessThan(8 / 24);
    pending.resolve(bitmap);
    await flushFrames();
    render(200);
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(8.5 / 24);
    expect(
      calls.uniform1f.mock.calls
        .filter(([name]) => name === "u_mix")
        .slice(-1)[0],
    ).toEqual(["u_mix", 0]);
  });

  it("ignores a late seek after a newer request", async () => {
    const { layer } = await setup();
    const old = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockImplementation(
      (index) => (index === 8 ? old.promise : Promise.resolve(bitmap)),
    );
    layer.setTime(times[8]);
    layer.setTime(times[4]);
    await flushFrames();
    old.resolve(bitmap);
    await flushFrames();
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(4.5 / 24);
  });

  it("clamps seeks and loops inside the selected range", async () => {
    const { layer, calls, render, events } = await setup({
      timeRange: [times[2], times[4]],
    });
    layer.setTime(times[0]);
    await flushFrames();
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(2.5 / 24);
    await layer.play();
    render(0);
    render(3500);
    expect(events.timeChange).toHaveBeenLastCalledWith(times[2]);
    expect(calls.uniform1f).toHaveBeenCalledWith("u_mix", 0.5);
    expect(events.playbackEnd).not.toHaveBeenCalled();
    expect(() => layer.setTimeRange([times[5], times[2]])).toThrow();
    expect(() => layer.setTimeRange([times[11] + 1, times[11] + 2])).toThrow(
      /overlap/,
    );
  });

  it("ends once and retains the final exact step without a following chunk", async () => {
    const { layer, events, render } = await setup({
      loop: false,
      timeRange: [times[0], times[1]],
    });
    await layer.play();
    render(0);
    render(2500);
    render(3000);
    expect(events.playbackEnd).toHaveBeenCalledOnce();
    expect(events.playbackChange.mock.calls).toEqual([[true], [false]]);
    expect(events.timeChange).toHaveBeenLastCalledWith(times[1]);
    expect(layer.getDebugInfo().playing).toBe(false);
  });

  it("repaints a late terminal step after the clock has stopped", async () => {
    const { layer, render, calls, map } = await setup({
      loop: false,
      timeRange: [times[0], times[8]],
    });
    const pending = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockReturnValue(
      pending.promise,
    );
    await layer.play();
    render(0);
    render(9000);
    expect(layer.getDebugInfo().playing).toBe(false);
    map.triggerRepaint.mockClear();
    pending.resolve(bitmap);
    await flushFrames();
    expect(map.triggerRepaint).toHaveBeenCalled();
    render(9100);
    expect(
      calls.uniform1f.mock.calls
        .filter(([name]) => name === "u_mix")
        .slice(-1)[0],
    ).toEqual(["u_mix", 0]);
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(8.5 / 24);
  });

  it("suspends and resumes the same playhead", async () => {
    const { layer, render } = await setup();
    await layer.play();
    render(0);
    render(1200);
    layer.suspend();
    await flushFrames();
    render(5000);
    expect(layer.getDebugInfo().playing).toBe(false);
    layer.resume();
    render(10000);
    expect(layer.getDebugInfo().playing).toBe(true);
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(1.5 / 24);
  });

  it("reports decode errors through the public events", async () => {
    const { layer, events } = await setup();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockRejectedValue(
      new Error("decode failed"),
    );
    layer.setTime(times[8]);
    await flushFrames();
    expect(events.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "decode failed" }),
    );
    expect(events.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error" }),
    );
  });
});

describe("GeoVideoLayer chunk handoff", () => {
  it("keeps playing through a preloaded handoff and emits one end event", async () => {
    const { layer, events, render } = await setup({
      loop: false,
      timeRange: [times[0], times[1]],
    });
    expect(layer.preloadManifest(nextManifest)).toBe(true);
    await flushFrames();
    await layer.play();
    render(0);
    render(2500);
    render(2600);
    expect(events.playbackEnd).toHaveBeenCalledOnce();
    expect(events.playbackChange.mock.calls).toEqual([[true]]);
    expect(layer.getDebugInfo().playing).toBe(true);
    expect(layer.replaceManifest(nextManifest)).toBe(true);
    await flushFrames();
    expect(layer.getManifest()).toBe(nextManifest);
    expect(events.loaded).toHaveBeenCalledTimes(2);
    expect(events.playbackChange.mock.calls).toEqual([[true], [true]]);
    render(2000);
    render(2500);
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(0.5 / 24);
  });

  it("keeps the outgoing textures and mask until an unprepared swap is ready", async () => {
    const { layer, render, calls } = await setup();
    render(0);
    const pending = deferred<ImageBitmap>();
    vi.mocked(GeoVideoScalarSource.prototype.frame).mockReturnValue(
      pending.promise,
    );
    expect(layer.replaceManifest(nextManifest)).toBe(true);
    render(100);
    expect(calls.drawElements).toHaveBeenCalledTimes(4);
    expect(calls.deleteTexture).not.toHaveBeenCalled();
    pending.resolve(bitmap);
    await flushFrames();
    render(200);
    expect(calls.deleteTexture).toHaveBeenCalled();
    expect(layer.getDebugInfo().manifestId).toBe("next");
  });

  it("honors pause while waiting for or loading the next chunk", async () => {
    const { layer, render, events } = await setup({
      loop: false,
      timeRange: [times[0], times[1]],
    });
    layer.preloadManifest(nextManifest);
    await flushFrames();
    await layer.play();
    render(0);
    render(2500);
    layer.pause();
    layer.replaceManifest(nextManifest);
    await flushFrames();
    expect(layer.getDebugInfo().playing).toBe(false);
    expect(events.playbackChange.mock.calls).toEqual([[true], [false]]);
  });

  it("rejects incompatible replacements and releases preloads on removal", async () => {
    const { layer, calls } = await setup();
    expect(
      layer.replaceManifest({
        ...nextManifest,
        media: { ...nextManifest.media, width: 32 },
      }),
    ).toBe(false);
    layer.preloadManifest(nextManifest);
    await flushFrames();
    const release = vi.spyOn(GeoVideoScalarSource.prototype, "release");
    layer.onRemove();
    expect(release).toHaveBeenCalledTimes(2);
    expect(calls.deleteTexture).toHaveBeenCalled();
    expect(layer.getDebugInfo().initialized).toBe(false);
  });
});

describe("GeoVideoLayer snapshot playback", () => {
  const snapshot: GeoVideoManifest = {
    ...scalarManifest,
    timeline: { kind: "snapshot-loop", date: new Date(times[0]).toISOString() },
  };

  it("plays decoded media frames while reporting the snapshot date only once", async () => {
    const { layer, events, render } = await setup({
      manifest: snapshot,
      playbackRate: 1,
      loop: false,
    });
    await layer.play();
    render(0);
    render(100);
    await flushFrames();
    render(100);
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(0.1);
    expect(events.timeChange.mock.calls).toEqual([[times[0]]]);
    layer.pause();
    await flushFrames();
    render(200);
    expect(layer.getDebugInfo().currentTime).toBeCloseTo(2 / 24);
    await layer.play();
    render(1000);
    render(2500);
    expect(events.playbackEnd).toHaveBeenCalledOnce();
  });

  it("wraps a snapshot's decoded frames without changing its public date", async () => {
    const { layer, events, render } = await setup({
      manifest: snapshot,
      playbackRate: 1,
    });
    await layer.play();
    render(0);
    render(600);
    expect(layer.getDebugInfo().playing).toBe(true);
    expect(events.timeChange.mock.calls).toEqual([[times[0]]]);
    expect(events.playbackEnd).not.toHaveBeenCalled();
    layer.setTime(times[0]);
    await flushFrames();
    expect(layer.getDebugInfo().currentTime).toBe(0);
  });
});
