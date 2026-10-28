import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeoVideoPlayback,
  type GeoVideoPlaybackOptions,
} from "./GeoVideoPlayback";
import {
  GeoVideoVectorSource,
  type GeoVideoVectorFrame,
} from "./GeoVideoVectorSource";
import { geoVideoTimelineValues } from "./geovideo";
import {
  deferred,
  flushFrames,
  geoVideoTestGl,
  vectorManifest,
} from "./test-geovideo";

const times = geoVideoTimelineValues(vectorManifest);
const frame = {
  u: new Float32Array(128).fill(1),
  v: new Float32Array(128).fill(-0.5),
};
beforeEach(() =>
  vi.spyOn(GeoVideoVectorSource.prototype, "frame").mockResolvedValue(frame),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(options: GeoVideoPlaybackOptions = {}) {
  const { gl } = geoVideoTestGl();
  const emit = vi.fn();
  const playback = new GeoVideoPlayback(
    { autoplay: false, stepsPerSecond: 1, ...options },
    vi.fn(),
    emit,
  );
  await playback.load(gl, vectorManifest);
  await flushFrames();
  return { playback, emit };
}

describe("shared GeoVideo vector playback", () => {
  it.each([0.01, 1, 20])(
    "keeps fractional step timing at %s steps per second",
    async (speed) => {
      const { playback } = await setup({ stepsPerSecond: speed });
      await playback.play();
      playback.sample(0);
      const pair = playback.sample(500 / speed)!;
      expect(pair[2]).toBeCloseTo(0.5);
      expect(pair[0]).not.toBe(pair[1]);
      playback.destroy();
    },
  );

  it("loads a requested step first and keeps the previous pair until it is ready", async () => {
    const { playback } = await setup();
    await playback.play();
    playback.sample(0);
    const previous = playback.sample(500);
    const waiting = deferred<GeoVideoVectorFrame>();
    vi.mocked(GeoVideoVectorSource.prototype.frame).mockImplementation(
      (index) => (index === 8 ? waiting.promise : Promise.resolve(frame)),
    );
    playback.setTime(times[8]);
    expect(playback.sample(2000)).toBe(previous);
    waiting.resolve(frame);
    await flushFrames();
    const sought = playback.sample(3000)!;
    expect(sought[2]).toBe(0);
    expect(sought[0]).toBe(sought[1]);
    expect(playback.time).toBe(times[8]);
    playback.destroy();
  });

  it("keeps a complete pair when its next texture is still decoding", async () => {
    const { playback } = await setup();
    await playback.play();
    playback.sample(0);
    const previous = playback.sample(500);
    const waiting = deferred<GeoVideoVectorFrame>();
    vi.mocked(GeoVideoVectorSource.prototype.frame).mockImplementation(
      (index) => (index === 5 ? waiting.promise : Promise.resolve(frame)),
    );
    playback.sample(4500);
    await flushFrames();
    expect(playback.sample(4500)).toBe(previous);
    waiting.resolve(frame);
    await flushFrames();
    expect(playback.sample(4500)![2]).toBe(0.5);
    playback.destroy();
  });

  it("clamps seeks, loops within a range and honors pause during a pending replacement", async () => {
    const { playback, emit } = await setup({ timeRange: [times[2], times[4]] });
    playback.setTime(times[0]);
    await flushFrames();
    expect(playback.time).toBe(times[2]);
    await playback.play();
    playback.sample(0);
    playback.sample(3500);
    expect(playback.time).toBe((times[2] + times[3]) / 2);
    const waiting = deferred<GeoVideoVectorFrame>();
    vi.mocked(GeoVideoVectorSource.prototype.frame).mockReturnValue(
      waiting.promise,
    );
    const last = playback.sample(3500);
    expect(
      playback.replaceManifest({
        ...vectorManifest,
        media: { ...vectorManifest.media, url: "next.mp4" },
      }),
    ).toBe(true);
    expect(playback.sample(4000)).toBe(last);
    playback.pause();
    waiting.resolve(frame);
    await flushFrames();
    expect(playback.isPlaying()).toBe(false);
    expect(playback.sample(5000)![2]).toBe(0);
    expect(emit).not.toHaveBeenCalledWith("playbackEnd");
    playback.destroy();
  });

  it("reports one decode failure, freezes the pair and can retry on play", async () => {
    const { playback, emit } = await setup();
    await playback.play();
    playback.sample(0);
    const previous = playback.sample(500);
    const failure = new Error("decoder failed");
    vi.mocked(GeoVideoVectorSource.prototype.frame).mockRejectedValue(failure);
    playback.sample(4500);
    playback.sample(4500);
    await flushFrames();
    expect(playback.isPlaying()).toBe(false);
    expect(emit.mock.calls.filter(([event]) => event === "error")).toEqual([
      ["error", failure],
    ]);
    expect(playback.sample(5000)).toBe(previous);
    vi.mocked(GeoVideoVectorSource.prototype.frame).mockResolvedValue(frame);
    await playback.play();
    await flushFrames();
    expect(playback.isPlaying()).toBe(true);
    expect(playback.sample(6000)![2]).toBe(0);
    playback.destroy();
  });
});
