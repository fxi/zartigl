import { afterEach, describe, expect, it, vi } from "vitest";
import { GeoVideoLayer } from "./GeoVideoLayer";
import type { GeoVideoLayerOptions } from "./GeoVideoLayer";
import { geoVideoSecondsForTime } from "./geovideo";
import type { GeoVideoManifest } from "./geovideo";

const manifest: GeoVideoManifest = {
  schemaVersion: 3,
  id: "test-values",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -90, 180, 90],
  media: {
    url: "values.mp4",
    mimeType: "video/mp4",
    width: 16,
    height: 8,
    fps: 24,
    durationSeconds: 30,
    codec: "h264",
  },
  encoding: {
    kind: "scalar-luma", bits: 8, codeMin: 8, codeMax: 247,
    valueMin: -3, valueMax: 3, transfer: "linear", colorSpace: "bt709", colorRange: "limited",
  },
  mask: {
    kind: "static-validity", url: "mask.png", mimeType: "image/png",
    width: 16, height: 8, threshold: 0.5,
  },
  timeline: {
    kind: "range",
    dateStart: "2026-01-01T00:00:00Z",
    dateEnd: "2026-07-01T00:00:00Z",
    interpolation: "linear",
  },
  provenance: {
    catalogEntryId: "entry",
    inputSourceId: "source",
    identifiers: { dataset: "test" },
    variables: ["test"],
    generatedAt: "2026-07-02T00:00:00Z",
  },
  style: { palette: "balance", colorDomain: [-3, 3] },
};

type VideoFrameCallback = (
  now: number,
  metadata: { mediaTime?: number; presentedFrames?: number },
) => void;

class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  currentTime = 0;
  playbackRate = 1;
  readyState = 2;
  networkState = 1;
  videoWidth = 16;
  videoHeight = 8;
  crossOrigin = "";
  muted = false;
  loop = false;
  playsInline = false;
  preload = "";
  src = "";
  frameCallback: VideoFrameCallback | null = null;
  cancelledFrameCallback: number | null = null;

  constructor(withVideoFrameCallback: boolean) {
    super();
    if (withVideoFrameCallback) {
      Object.assign(this, {
        requestVideoFrameCallback: (callback: VideoFrameCallback) => {
          this.frameCallback = callback;
          return 42;
        },
        cancelVideoFrameCallback: (handle: number) => {
          this.cancelledFrameCallback = handle;
          this.frameCallback = null;
        },
      });
    }
  }

  async play(): Promise<void> {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("playing"));
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  load(): void {}
  removeAttribute(_name: string): void {}
  getVideoPlaybackQuality(): VideoPlaybackQuality {
    return { creationTime: 0, totalVideoFrames: 12, droppedVideoFrames: 2, corruptedVideoFrames: 0 };
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly drawImage = vi.fn();
  getContext(_type: string): Pick<CanvasRenderingContext2D, "drawImage"> {
    return { drawImage: this.drawImage };
  }
}

class FakeImage extends EventTarget {
  crossOrigin = "";
  src = "";
  naturalWidth = 16;
  naturalHeight = 8;
}

function setup(
  withVideoFrameCallback = true,
  manifestValue: GeoVideoManifest = manifest,
  options: Partial<GeoVideoLayerOptions> = {},
) {
  const video = new FakeVideo(withVideoFrameCallback);
  video.videoWidth = manifestValue.media.width;
  video.videoHeight = manifestValue.media.height;
  const triggerRepaint = vi.fn();
  const canvases: FakeCanvas[] = [];
  const images: FakeImage[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.stubGlobal("document", {
    createElement: vi.fn((tag: string) => {
      if (tag === "video") return video;
      if (tag === "img") {
        const image = new FakeImage();
        images.push(image);
        return image;
      }
      const canvas = new FakeCanvas();
      canvases.push(canvas);
      return canvas;
    }),
  });
  vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const handle = nextFrame++;
    animationFrames.set(handle, callback);
    return handle;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((handle: number) => {
    animationFrames.delete(handle);
  }));

  const layer = new GeoVideoLayer({
    id: "test",
    manifest: manifestValue,
    autoplay: false,
    ...options,
  });
  const internal = layer as unknown as {
    map: { triggerRepaint: () => void };
    manifest: GeoVideoManifest;
    timeRange: [number, number] | null;
    initVideo: (value: GeoVideoManifest) => void;
  };
  internal.map = { triggerRepaint };
  internal.manifest = manifestValue;
  internal.timeRange = options.timeRange ?? null;
  internal.initVideo(manifestValue);
  return { layer, video, triggerRepaint, animationFrames, canvases, images };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeoVideoLayer playback scheduling", () => {
  it("seeks to the allowed range before the first frame is buffered", () => {
    const start = Date.parse("2026-03-01T00:00:00Z");
    const end = Date.parse("2026-05-01T00:00:00Z");
    const { video } = setup(true, manifest, { timeRange: [start, end] });

    video.dispatchEvent(new Event("loadedmetadata"));

    expect(video.currentTime).toBeCloseTo(geoVideoSecondsForTime(manifest, start));
  });

  it("applies an initial time before the first frame and clamps it to the range", () => {
    const start = Date.parse("2026-03-01T00:00:00Z");
    const end = Date.parse("2026-05-01T00:00:00Z");
    const requested = Date.parse("2026-06-01T00:00:00Z");
    const { video } = setup(true, manifest, {
      time: requested,
      timeRange: [start, end],
    });

    video.dispatchEvent(new Event("loadedmetadata"));

    expect(video.currentTime).toBeCloseTo(geoVideoSecondsForTime(manifest, end));
  });

  it("retains a time requested before media initialization", () => {
    const requested = Date.parse("2026-04-01T00:00:00Z");
    const { layer, video } = setup();

    layer.setTime(requested);
    video.currentTime = 0;
    video.dispatchEvent(new Event("loadedmetadata"));

    expect(video.currentTime).toBeCloseTo(geoVideoSecondsForTime(manifest, requested));
  });

  it("loads a static mask independently without copying the value video through canvas", () => {
    const { layer, video, images, canvases } = setup();
    expect(images).toHaveLength(1);
    expect(canvases).toHaveLength(1);
    expect(images[0].src).toBe("mask.png");
    images[0].dispatchEvent(new Event("load"));
    video.dispatchEvent(new Event("loadeddata"));

    expect(canvases[0].drawImage).toHaveBeenCalledWith(images[0], 0, 0, 16, 8);
    expect(canvases[0].drawImage).not.toHaveBeenCalledWith(video, expect.anything());
    expect(layer.getDebugInfo().bufferedFrames).toBe(1);
    expect((layer as unknown as { colorCanvas?: unknown }).colorCanvas).toBeUndefined();
  });

  it("accepts the video element itself as a WebGL texture source", () => {
    const { layer, video } = setup();
    const gl = {
      TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, UNPACK_FLIP_Y_WEBGL: 0x9240,
      getParameter: vi.fn(() => false), pixelStorei: vi.fn(),
      texImage2D: vi.fn(), texSubImage2D: vi.fn(),
    };
    const upload = (layer as unknown as {
      uploadTextureSource: (context: WebGLRenderingContext, source: HTMLVideoElement, initialized: boolean) => void;
    }).uploadTextureSource.bind(layer);

    upload(gl as unknown as WebGLRenderingContext, video as unknown as HTMLVideoElement, false);
    upload(gl as unknown as WebGLRenderingContext, video as unknown as HTMLVideoElement, true);

    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video,
    );
    expect(gl.texSubImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video,
    );
  });

  it("does not report ready until both video and mask are loaded", () => {
    const { layer, video, images } = setup();
    const loaded = vi.fn();
    layer.on("loaded", loaded);

    video.dispatchEvent(new Event("loadeddata"));
    expect(loaded).not.toHaveBeenCalled();

    images[0].dispatchEvent(new Event("load"));
    expect(loaded).toHaveBeenCalledOnce();
  });

  it("reports a mask dimension mismatch", () => {
    const { layer, images } = setup();
    const error = vi.fn();
    layer.on("error", error);
    images[0].naturalWidth = 8;

    images[0].dispatchEvent(new Event("load"));

    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("dimensions") }));
  });

  it("does not run a continuous repaint loop when video frame callbacks are available", async () => {
    const { layer, video, triggerRepaint, animationFrames } = setup();

    await layer.play();
    expect(triggerRepaint).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(0);

    video.frameCallback!(16, { mediaTime: 1, presentedFrames: 1 });
    expect(triggerRepaint).toHaveBeenCalledOnce();
    expect(animationFrames.size).toBe(0);
  });

  it("repaints continuously as a fallback without video frame callbacks", async () => {
    const { layer, video, triggerRepaint, animationFrames } = setup(false);

    await layer.play();
    expect(triggerRepaint).toHaveBeenCalledTimes(1);
    expect(animationFrames.size).toBe(1);

    const callback = animationFrames.values().next().value as FrameRequestCallback;
    animationFrames.clear();
    callback(16);
    expect(triggerRepaint).toHaveBeenCalledTimes(2);
    expect(animationFrames.size).toBe(1);

    video.dispatchEvent(new Event("waiting"));
    expect(animationFrames.size).toBe(0);

    video.dispatchEvent(new Event("playing"));
    expect(animationFrames.size).toBe(1);
    layer.pause();
    expect(animationFrames.size).toBe(0);
  });

  it("marks decoded frames and exposes playback quality metrics", () => {
    const { layer, video, triggerRepaint } = setup();
    const callback = video.frameCallback!;

    callback(10, { mediaTime: 1, presentedFrames: 7 });

    expect(triggerRepaint).toHaveBeenCalledTimes(1);
    expect(layer.getDebugInfo()).toMatchObject({
      decodedFrames: 7,
      bufferedFrames: 1,
      uploadedFrames: 0,
      droppedFrames: 2,
      frameCallbackCount: 1,
      readyState: 2,
      networkState: 1,
    });
  });

  it("uses timeupdate when requestVideoFrameCallback is unavailable", () => {
    const { layer, video, triggerRepaint } = setup(false);

    video.currentTime = 1;
    video.dispatchEvent(new Event("timeupdate"));

    expect(triggerRepaint).toHaveBeenCalledTimes(1);
    expect(layer.getDebugInfo().decodedFrames).toBe(1);
  });

  it("applies playback rate and reports playback state", async () => {
    const { layer, video } = setup();
    const states: boolean[] = [];
    layer.on("playbackChange", (playing) => states.push(playing));

    layer.setPlaybackRate(5);
    await layer.play();
    layer.pause();

    expect(video.playbackRate).toBe(5);
    expect(states).toEqual([true, false]);
  });

  it("stops at the timeline end when looping is disabled", async () => {
    const { layer, video } = setup();
    const times: number[] = [];
    layer.on("timeChange", (time) => times.push(time));
    layer.setLoop(false);
    await layer.play();

    video.frameCallback!(10, { mediaTime: 30, presentedFrames: 1 });

    expect(video.paused).toBe(true);
    expect(times[times.length - 1]).toBe(new Date("2026-07-01T00:00:00Z").getTime());
  });

  it("restarts at the allowed range start when the media ends while looping", async () => {
    const { layer, video } = setup();
    const states: boolean[] = [];
    layer.on("playbackChange", (playing) => states.push(playing));
    layer.setLoop(true);
    await layer.play();

    video.currentTime = 30;
    video.paused = true;
    video.ended = true;
    video.dispatchEvent(new Event("pause"));
    video.dispatchEvent(new Event("ended"));
    await Promise.resolve();

    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
    expect(states).not.toContain(false);
  });

  it("cancels video and animation callbacks when removed", async () => {
    const { layer, video, animationFrames } = setup();
    await layer.play();

    layer.onRemove();

    expect(animationFrames.size).toBe(0);
    expect(video.cancelledFrameCallback).toBe(42);
  });
});
