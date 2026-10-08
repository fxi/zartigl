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
    kind: "scalar-luma",
    bits: 8,
    codeMin: 8,
    codeMax: 247,
    valueMin: -3,
    valueMax: 3,
    transfer: "linear",
    colorSpace: "bt709",
    colorRange: "limited",
  },
  mask: {
    kind: "static-validity",
    url: "mask.png",
    mimeType: "image/png",
    width: 16,
    height: 8,
    threshold: 0.5,
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
  seeking = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
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
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  load(): void {}
  readonly removeAttribute = vi.fn();
  getVideoPlaybackQuality(): VideoPlaybackQuality {
    return {
      creationTime: 0,
      totalVideoFrames: 12,
      droppedVideoFrames: 2,
      corruptedVideoFrames: 0,
    };
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
  complete = false;
  crossOrigin = "";
  src = "";
  naturalWidth = 16;
  naturalHeight = 8;
}

function setup(
  withVideoFrameCallback = true,
  manifestValue: GeoVideoManifest = manifest,
  options: Partial<GeoVideoLayerOptions> = {},
  beforeInit?: (layer: GeoVideoLayer) => void,
) {
  const video = new FakeVideo(withVideoFrameCallback);
  video.videoWidth = manifestValue.media.width;
  video.videoHeight = manifestValue.media.height;
  const triggerRepaint = vi.fn();
  const canvases: FakeCanvas[] = [];
  const images: FakeImage[] = [];
  const videos: FakeVideo[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.stubGlobal("document", {
    createElement: vi.fn((tag: string) => {
      if (tag === "video") {
        const created = videos.length
          ? new FakeVideo(withVideoFrameCallback)
          : video;
        created.videoWidth = manifestValue.media.width;
        created.videoHeight = manifestValue.media.height;
        videos.push(created);
        return created;
      }
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
  vi.stubGlobal("HTMLMediaElement", {
    HAVE_METADATA: 1,
    HAVE_CURRENT_DATA: 2,
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const handle = nextFrame++;
      animationFrames.set(handle, callback);
      return handle;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((handle: number) => {
      animationFrames.delete(handle);
    }),
  );

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
  beforeInit?.(layer);
  internal.initVideo(manifestValue);
  return {
    layer,
    video,
    videos,
    triggerRepaint,
    animationFrames,
    canvases,
    images,
  };
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

    expect(video.currentTime).toBeCloseTo(
      geoVideoSecondsForTime(manifest, start),
    );
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

    expect(video.currentTime).toBeCloseTo(
      geoVideoSecondsForTime(manifest, end),
    );
  });

  it("retains a time requested before media initialization", () => {
    const requested = Date.parse("2026-04-01T00:00:00Z");
    const { layer, video } = setup();

    layer.setTime(requested);
    video.currentTime = 0;
    video.dispatchEvent(new Event("loadedmetadata"));

    expect(video.currentTime).toBeCloseTo(
      geoVideoSecondsForTime(manifest, requested),
    );
  });

  it("loads a static mask independently without copying the value video through canvas", () => {
    const { layer, video, images, canvases } = setup();
    expect(images).toHaveLength(1);
    expect(canvases).toHaveLength(1);
    expect(images[0].src).toBe("mask.png");
    images[0].dispatchEvent(new Event("load"));
    video.dispatchEvent(new Event("loadeddata"));

    expect(canvases[0].drawImage).toHaveBeenCalledWith(images[0], 0, 0, 16, 8);
    expect(canvases[0].drawImage).not.toHaveBeenCalledWith(
      video,
      expect.anything(),
    );
    expect(layer.getDebugInfo().bufferedFrames).toBe(1);
    expect(
      (layer as unknown as { colorCanvas?: unknown }).colorCanvas,
    ).toBeUndefined();
  });

  it("accepts the video element itself as a WebGL texture source", () => {
    const { layer, video } = setup();
    const gl = {
      TEXTURE_2D: 0x0de1,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      getParameter: vi.fn(() => false),
      pixelStorei: vi.fn(),
      texImage2D: vi.fn(),
      texSubImage2D: vi.fn(),
    };
    const upload = (
      layer as unknown as {
        uploadTextureSource: (
          context: WebGLRenderingContext,
          source: HTMLVideoElement,
          initialized: boolean,
        ) => void;
      }
    ).uploadTextureSource.bind(layer);

    upload(
      gl as unknown as WebGLRenderingContext,
      video as unknown as HTMLVideoElement,
      false,
    );
    upload(
      gl as unknown as WebGLRenderingContext,
      video as unknown as HTMLVideoElement,
      true,
    );

    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      video,
    );
    expect(gl.texSubImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      video,
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

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("dimensions"),
      }),
    );
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

    const callback = animationFrames.values().next()
      .value as FrameRequestCallback;
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
    expect(times[times.length - 1]).toBe(
      new Date("2026-07-01T00:00:00Z").getTime(),
    );
  });

  it("keeps the requested speed after the media load resets the rate", () => {
    const { video } = setup(true, manifest, { playbackRate: 0.25 });
    expect(video.defaultPlaybackRate).toBe(0.25);
    // HTMLMediaElement.load() restores playbackRate from defaultPlaybackRate.
    video.playbackRate = 1;
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.playbackRate).toBe(0.25);
  });

  it("reports the end of playback once when looping is disabled", async () => {
    const { layer, video } = setup();
    const ends: number[] = [];
    layer.on("playbackEnd", () => ends.push(1));
    layer.setLoop(false);
    await layer.play();

    video.frameCallback!(10, { mediaTime: 30, presentedFrames: 1 });
    video.ended = true;
    video.dispatchEvent(new Event("ended"));
    expect(ends).toHaveLength(1);

    layer.pause();
    expect(ends).toHaveLength(1);
  });

  it("steps through frames below the slowest media rate browsers accept", async () => {
    vi.useFakeTimers();
    try {
      const { layer, video } = setup();
      const states: boolean[] = [];
      const ends: number[] = [];
      layer.on("playbackChange", (playing) => states.push(playing));
      layer.on("playbackEnd", () => ends.push(1));
      layer.setLoop(false);
      layer.setPlaybackRate(1 / 100);
      expect(video.playbackRate).toBe(1 / 16);

      await layer.play();
      expect(video.paused).toBe(true);
      expect(layer.getDebugInfo().playing).toBe(true);
      const start = video.currentTime;
      // One frame (1/24 s of media) per 1/24 / (1/100) s = ~4.17 s.
      vi.advanceTimersByTime(4200);
      expect(video.currentTime).toBeCloseTo(start + 1 / 24);

      layer.pause();
      const paused = video.currentTime;
      vi.advanceTimersByTime(10_000);
      expect(video.currentTime).toBe(paused);
      expect(states).toEqual([true, false]);

      video.currentTime = 29.8;
      await layer.play();
      vi.advanceTimersByTime(60_000);
      expect(ends).toHaveLength(1);
      expect(layer.getDebugInfo().playing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns from stepped to native playback when the rate rises", async () => {
    vi.useFakeTimers();
    try {
      const { layer, video } = setup();
      layer.setPlaybackRate(1 / 100);
      await layer.play();
      layer.setPlaybackRate(2);
      await Promise.resolve();
      expect(video.paused).toBe(false);
      expect(video.playbackRate).toBe(2);
      const time = video.currentTime;
      vi.advanceTimersByTime(10_000);
      expect(video.currentTime).toBe(time);
    } finally {
      vi.useRealTimers();
    }
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

const nextManifest: GeoVideoManifest = {
  ...manifest,
  id: "test-values-next",
  media: { ...manifest.media, url: "next.mp4" },
  timeline: {
    kind: "range",
    dateStart: "2026-07-01T00:00:00Z",
    dateEnd: "2027-01-01T00:00:00Z",
    interpolation: "linear",
  },
};

function ready(setupResult: ReturnType<typeof setup>) {
  setupResult.images[0].dispatchEvent(new Event("load"));
  setupResult.video.dispatchEvent(new Event("loadeddata"));
}

/** WebGL stub: constants and getters are inert, uploads are recorded. */
function fakeGl() {
  const calls = {
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    getParameter: vi.fn(() => [0, 0, 0, 0]),
  };
  return {
    calls,
    gl: new Proxy(calls, {
      get: (target, prop) =>
        prop in target ? target[prop as keyof typeof target] : () => null,
    }) as unknown as WebGLRenderingContext,
  };
}

describe("GeoVideoLayer artifact swap", () => {
  it("keeps the shown media until the next artifact can show its first frame", async () => {
    const context = setup();
    const { layer, video: previous, videos, images } = context;
    ready(context);
    await layer.play();
    const events: string[] = [];
    layer.on("loading", () => events.push("loading"));
    layer.on("loaded", () => events.push("loaded"));
    layer.on("playbackChange", (playing) => events.push(`playing:${playing}`));
    layer.on("playbackEnd", () => events.push("end"));
    const target = Date.parse("2026-08-01T00:00:00Z");

    expect(layer.replaceManifest(nextManifest, { time: target })).toBe(true);
    expect(videos).toHaveLength(2);
    const next = videos[1];
    expect(next.src).toBe("next.mp4");
    // Same mask: not loaded again.
    expect(images).toHaveLength(1);
    expect(previous.paused).toBe(true);
    expect(previous.cancelledFrameCallback).toBe(42);
    expect(previous.removeAttribute).not.toHaveBeenCalled();

    // The outgoing media no longer drives the layer.
    previous.ended = true;
    previous.dispatchEvent(new Event("ended"));
    expect(layer.getDebugInfo().mediaUrl).toBe("next.mp4");

    next.dispatchEvent(new Event("loadedmetadata"));
    expect(next.currentTime).toBeCloseTo(
      geoVideoSecondsForTime(nextManifest, target),
    );
    next.seeking = true;
    next.dispatchEvent(new Event("loadeddata"));
    expect(events).toEqual([]);

    next.seeking = false;
    next.dispatchEvent(new Event("seeked"));
    await Promise.resolve();
    expect(previous.removeAttribute).toHaveBeenCalledWith("src");
    expect(next.paused).toBe(false);
    expect(events).toEqual(["loaded", "playing:true"]);
    expect(layer.getDebugInfo().bufferedFrames).toBe(2);
  });

  it("resumes only when playing or asked to play during the swap", async () => {
    const context = setup();
    const { layer, videos } = context;
    ready(context);

    layer.replaceManifest(nextManifest);
    layer.pause();
    videos[1].dispatchEvent(new Event("loadeddata"));
    await Promise.resolve();
    expect(videos[1].paused).toBe(true);

    layer.replaceManifest(manifest);
    await layer.play();
    expect(layer.getDebugInfo().playing).toBe(true);
    videos[2].dispatchEvent(new Event("loadeddata"));
    await Promise.resolve();
    expect(videos[2].paused).toBe(false);
  });

  it("discards a superseded swap", () => {
    const context = setup();
    const { layer, videos } = context;
    ready(context);
    const loaded = vi.fn();
    layer.on("loaded", loaded);

    layer.replaceManifest(nextManifest);
    layer.replaceManifest(manifest);
    expect(videos[1].removeAttribute).toHaveBeenCalledWith("src");
    videos[1].dispatchEvent(new Event("loadeddata"));
    expect(loaded).not.toHaveBeenCalled();
    videos[2].dispatchEvent(new Event("loadeddata"));
    expect(loaded).toHaveBeenCalledOnce();

    layer.replaceManifest(nextManifest);
    layer.onRemove();
    expect(videos[3].removeAttribute).toHaveBeenCalledWith("src");
  });

  it("asks for a new layer when the frame size differs", () => {
    const context = setup();
    ready(context);
    const larger = {
      ...nextManifest,
      media: { ...nextManifest.media, width: 32 },
    };
    expect(context.layer.replaceManifest(larger)).toBe(false);
    expect(context.videos).toHaveLength(1);
  });

  it("keeps the last uploaded frame while the media is seeking", () => {
    const context = setup();
    const { layer, video } = context;
    ready(context);
    Object.assign(layer as unknown as Record<string, unknown>, {
      colorTexture: {},
      maskTexture: {},
    });
    const { gl, calls } = fakeGl();
    const options = {} as Parameters<GeoVideoLayer["render"]>[1];
    const videoUploads = () =>
      calls.texImage2D.mock.calls.filter((args) => args.includes(video));

    video.seeking = true;
    layer.render(gl, options);
    video.seeking = false;
    video.readyState = 1;
    layer.render(gl, options);
    expect(videoUploads()).toHaveLength(0);

    video.readyState = 2;
    layer.render(gl, options);
    expect(videoUploads()).toHaveLength(1);
  });
});

describe("GeoVideoLayer preloading", () => {
  const nextStart = Date.parse("2026-07-01T00:00:00Z");
  const withMask = {
    ...nextManifest,
    mask: { ...nextManifest.mask, url: "next-mask.png" },
  };

  /** Playing archive chunk with the next one preloaded and decodable. */
  async function preloaded(next: GeoVideoManifest = nextManifest) {
    const context = setup(true, manifest, { loop: false });
    ready(context);
    await context.layer.play();
    expect(context.layer.preloadManifest(next, { time: nextStart })).toBe(true);
    const standby = context.videos[1];
    standby.dispatchEvent(new Event("loadedmetadata"));
    standby.dispatchEvent(new Event("loadeddata"));
    const events: string[] = [];
    context.layer.on("loaded", () => events.push("loaded"));
    context.layer.on("playbackChange", (playing) =>
      events.push(`playing:${playing}`),
    );
    context.layer.on("playbackEnd", () => events.push("end"));
    return { ...context, standby, events };
  }

  /** The current media plays to its end, as a browser reports it. */
  function finish(video: FakeVideo) {
    video.ended = true;
    video.pause();
    video.dispatchEvent(new Event("ended"));
  }

  it("hands off to the preloaded artifact without pausing or reloading", async () => {
    const { layer, video, videos, standby, events } = await preloaded();
    expect(standby.src).toBe("next.mp4");
    expect(standby.currentTime).toBeCloseTo(
      geoVideoSecondsForTime(nextManifest, nextStart),
    );
    expect(layer.getDebugInfo()).toMatchObject({
      mediaUrl: "values.mp4",
      preloadedMediaUrl: "next.mp4",
    });

    finish(video);
    expect(events).toEqual(["end"]);
    expect(layer.getDebugInfo().playing).toBe(true);

    expect(layer.replaceManifest(nextManifest, { time: nextStart })).toBe(true);
    // Shown at once: no new media element and no seek.
    expect(videos).toHaveLength(2);
    expect(layer.getDebugInfo()).toMatchObject({
      mediaUrl: "next.mp4",
      preloadedMediaUrl: undefined,
    });
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    await Promise.resolve();
    expect(standby.paused).toBe(false);
    expect(events).toEqual(["end", "loaded", "playing:true"]);
  });

  it("seeks a preloaded artifact once when the swap asks for another time", async () => {
    const { layer, standby, events } = await preloaded();
    const target = Date.parse("2026-08-01T00:00:00Z");
    // Like a browser, assigning the position starts a seek.
    let position = standby.currentTime;
    Object.defineProperty(standby, "currentTime", {
      get: () => position,
      set: (value: number) => {
        position = value;
        standby.seeking = true;
      },
    });

    layer.replaceManifest(nextManifest, { time: target });
    expect(standby.currentTime).toBeCloseTo(
      geoVideoSecondsForTime(nextManifest, target),
    );
    expect(events).toEqual([]);

    standby.seeking = false;
    standby.dispatchEvent(new Event("seeked"));
    expect(events).toEqual(["loaded", "playing:true"]);
  });

  it("reports a pause requested while waiting for the next artifact", async () => {
    const { layer, video, standby, events } = await preloaded();
    finish(video);

    layer.pause();
    expect(events).toEqual(["end", "playing:false"]);
    expect(layer.getDebugInfo().playing).toBe(false);

    layer.replaceManifest(nextManifest, { time: nextStart });
    await Promise.resolve();
    expect(standby.paused).toBe(true);
    expect(events).toEqual(["end", "playing:false", "loaded"]);
  });

  it("plays once ready when asked before the manifest has loaded", async () => {
    const states: boolean[] = [];
    const context = setup(true, manifest, {}, (layer) => {
      layer.on("playbackChange", (playing) => states.push(playing));
      void layer.play();
      expect(layer.getDebugInfo().playing).toBe(true);
    });
    expect(context.video.paused).toBe(true);

    ready(context);
    await Promise.resolve();
    expect(context.video.paused).toBe(false);
    expect(states).toEqual([true]);
  });

  it("stops at the end when nothing is preloaded", async () => {
    const context = setup(true, manifest, { loop: false });
    ready(context);
    await context.layer.play();
    const events: string[] = [];
    context.layer.on("playbackChange", (playing) =>
      events.push(`playing:${playing}`),
    );
    context.layer.on("playbackEnd", () => events.push("end"));

    finish(context.video);
    expect(events).toEqual(["playing:false", "end"]);
    expect(context.layer.getDebugInfo().playing).toBe(false);
  });

  it("drops a preload that the swap or the layer no longer needs", async () => {
    const { layer, videos, standby } = await preloaded();
    const other = {
      ...nextManifest,
      media: { ...nextManifest.media, url: "other.mp4" },
    };

    layer.replaceManifest(other);
    expect(standby.removeAttribute).toHaveBeenCalledWith("src");
    expect(videos).toHaveLength(3);
    expect(videos[2].src).toBe("other.mp4");

    // The current media is not preloaded again.
    expect(layer.preloadManifest(other)).toBe(false);
    expect(layer.preloadManifest(nextManifest)).toBe(true);
    layer.onRemove();
    expect(videos[3].removeAttribute).toHaveBeenCalledWith("src");
  });

  it("ignores a failed preload until the swap loads the media itself", async () => {
    const { layer, videos, standby, events } = await preloaded();
    const errors = vi.fn();
    layer.on("error", errors);

    standby.dispatchEvent(new Event("error"));
    expect(errors).not.toHaveBeenCalled();
    expect(layer.getDebugInfo().preloadedMediaUrl).toBeUndefined();

    layer.replaceManifest(nextManifest, { time: nextStart });
    expect(videos).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it("shows a preloaded mask together with the first frame", async () => {
    const { layer, canvases, images } = await preloaded(withMask);
    const maskCanvas = canvases[0];
    images[0].dispatchEvent(new Event("load"));
    const draws = maskCanvas.drawImage.mock.calls.length;
    expect(images[1].src).toBe("next-mask.png");
    images[1].complete = true;

    layer.replaceManifest(withMask, { time: nextStart });
    expect(maskCanvas.drawImage).toHaveBeenCalledTimes(draws + 1);
    expect(maskCanvas.drawImage).toHaveBeenLastCalledWith(
      images[1],
      0,
      0,
      withMask.mask.width,
      withMask.mask.height,
    );
  });
});
