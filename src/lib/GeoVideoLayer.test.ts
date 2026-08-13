import { afterEach, describe, expect, it, vi } from "vitest";
import { GeoVideoLayer } from "./GeoVideoLayer";
import type { GeoVideoManifestV1 } from "./geovideo";

const manifest: GeoVideoManifestV1 = {
  schemaVersion: 1,
  id: "test-video",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -90, 180, 90],
  media: {
    url: "test.mp4",
    mimeType: "video/mp4",
    width: 16,
    height: 8,
    packedWidth: 32,
    packedHeight: 8,
    fps: 24,
    durationSeconds: 30,
    codec: "h264",
    alpha: "side-by-side",
  },
  timeline: {
    kind: "range",
    dateStart: "2026-01-01T00:00:00Z",
    dateEnd: "2026-07-01T00:00:00Z",
    interpolation: "linear",
  },
  provenance: {
    layerId: "test",
    datasetId: "test",
    variable: "test",
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
  readyState = 2;
  videoWidth = 32;
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

function setup(withVideoFrameCallback = true) {
  const video = new FakeVideo(withVideoFrameCallback);
  const triggerRepaint = vi.fn();
  const canvases: FakeCanvas[] = [];
  const animationFrames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.stubGlobal("document", {
    createElement: vi.fn((tag: string) => {
      if (tag === "video") return video;
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

  const layer = new GeoVideoLayer({ id: "test", manifest, autoplay: false });
  const internal = layer as unknown as {
    map: { triggerRepaint: () => void };
    manifest: GeoVideoManifestV1;
    initVideo: (value: GeoVideoManifestV1) => void;
  };
  internal.map = { triggerRepaint };
  internal.manifest = manifest;
  internal.initVideo(manifest);
  return { layer, video, triggerRepaint, animationFrames, canvases };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeoVideoLayer playback scheduling", () => {
  it("repaints continuously while playing and stops while paused or waiting", async () => {
    const { layer, video, triggerRepaint, animationFrames } = setup();

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
    });
  });

  it("uses timeupdate when requestVideoFrameCallback is unavailable", () => {
    const { layer, video, triggerRepaint } = setup(false);

    video.currentTime = 1;
    video.dispatchEvent(new Event("timeupdate"));

    expect(triggerRepaint).toHaveBeenCalledTimes(1);
    expect(layer.getDebugInfo().decodedFrames).toBe(1);
  });

  it("crops every color frame but captures the packed mask only once", () => {
    const { video, canvases } = setup();
    const [colorCanvas, maskCanvas] = canvases;

    video.dispatchEvent(new Event("loadeddata"));
    video.currentTime = 1;
    video.frameCallback!(10, { presentedFrames: 1 });
    video.currentTime = 2;
    video.frameCallback!(20, { presentedFrames: 2 });

    expect(colorCanvas.drawImage).toHaveBeenCalledTimes(3);
    expect(colorCanvas.drawImage).toHaveBeenLastCalledWith(
      video, 0, 0, 16, 8, 0, 0, 16, 8,
    );
    expect(maskCanvas.drawImage).toHaveBeenCalledTimes(1);
    expect(maskCanvas.drawImage).toHaveBeenCalledWith(
      video, 16, 0, 16, 8, 0, 0, 16, 8,
    );
  });

  it("keeps the previous buffered frame when a canvas snapshot fails", () => {
    const { layer, video, canvases } = setup();
    video.dispatchEvent(new Event("loadeddata"));
    const before = layer.getDebugInfo().bufferedFrames;
    canvases[0].drawImage.mockImplementationOnce(() => { throw new Error("decoder busy"); });

    video.currentTime = 1;
    video.frameCallback!(10, { presentedFrames: 1 });

    expect(layer.getDebugInfo()).toMatchObject({
      bufferedFrames: before,
      skippedFrames: 1,
    });
  });

  it("cancels video and animation callbacks when removed", async () => {
    const { layer, video, animationFrames } = setup();
    await layer.play();

    layer.onRemove();

    expect(animationFrames.size).toBe(0);
    expect(video.cancelledFrameCallback).toBe(42);
  });
});
