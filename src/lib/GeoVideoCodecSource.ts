import { abortError } from "./GeoVideoFrameSource";
import {
  GeoVideoScalarSource,
  type GeoVideoScalarFrame,
} from "./GeoVideoScalarSource";
import { parseMp4VideoTrack, type Mp4VideoTrack } from "./mp4";

/** Longest wait for decoder progress before feeding it the next sample. */
const PROGRESS_TIMEOUT_MS = 50;

/**
 * Scalar-luma GeoVideo decoded with WebCodecs, in decode order: playback
 * feeds the decoder sample after sample instead of seeking a video element,
 * which redecodes from the previous keyframe at every step. A step behind
 * the last one taken, or past a later keyframe, restarts at its keyframe.
 * Frames stay images, decoded on the GPU by GEOVIDEO_SCALAR_GLSL like those
 * of GeoVideoScalarSource, which serves browsers without WebCodecs for the
 * codec.
 */
export class GeoVideoCodecScalarSource extends GeoVideoScalarSource {
  private track: Mp4VideoTrack | null = null;
  private data: ArrayBuffer | null = null;
  /** Decode-order sample presenting each video frame. */
  private sampleOfFrame: number[] = [];
  private decoder: VideoDecoder | null = null;
  /** Next sample (decode order) to feed; -1 when the decoder needs a reset. */
  private fed = -1;
  /** Last video frame handed out; later frames can still be reached. */
  private taken = -1;
  /** Decoded frames not taken yet, by video frame. */
  private readonly outputs = new Map<number, VideoFrame>();
  private progress: (() => void) | null = null;
  private failure: Error | null = null;
  /** Aborts the media download of the current load on release. */
  private loading: AbortController | null = null;

  /** True once the media decodes through WebCodecs. */
  get usesWebCodecs(): boolean {
    return this.track !== null;
  }

  protected override async loadMedia(): Promise<void> {
    if (typeof VideoDecoder === "undefined" || typeof fetch === "undefined") {
      return super.loadMedia();
    }
    const loading = new AbortController();
    this.loading = loading;
    const response = await fetch(this.manifest.media.url, {
      signal: loading.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to load GeoVideo media: ${this.manifest.media.url}`,
      );
    }
    const data = await response.arrayBuffer();
    let track: Mp4VideoTrack;
    try {
      track = parseMp4VideoTrack(data);
    } catch {
      // A layout this parser does not follow, such as a trimming edit list.
      return this.loading === loading ? super.loadMedia() : undefined;
    }
    if (
      track.width !== this.manifest.media.width ||
      track.height !== this.manifest.media.height
    ) {
      throw new Error(
        `GeoVideo media dimensions ${track.width}x${track.height} do not match manifest ${this.manifest.media.width}x${this.manifest.media.height}`,
      );
    }
    const { supported } = await VideoDecoder.isConfigSupported(
      this.config(track),
    ).catch(() => ({ supported: false }));
    if (this.loading !== loading) {
      // Released meanwhile.
      throw abortError();
    }
    this.loading = null;
    if (!supported) {
      return super.loadMedia();
    }
    this.sampleOfFrame = [];
    track.samples.forEach(
      (sample, i) => (this.sampleOfFrame[sample.frame] = i),
    );
    this.data = data;
    this.track = track;
  }

  override release(): void {
    this.loading?.abort();
    this.loading = null;
    this.closeDecoder();
    this.track = null;
    this.data = null;
    super.release();
  }

  protected override async decode(
    index: number,
    signal: AbortSignal,
  ): Promise<GeoVideoScalarFrame> {
    await this.init();
    if (!this.track) {
      return super.decode(index, signal);
    }
    if (signal.aborted) {
      throw abortError();
    }
    // The tolerance keeps a frame start computed just below its integer on it.
    const frame = Math.min(
      this.track.samples.length - 1,
      Math.floor(this.stepSeconds(index) * this.manifest.media.fps + 1e-6),
    );
    const decoded = await this.decodeFrame(frame, signal);
    try {
      return await createImageBitmap(decoded, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
    } finally {
      decoded.close();
    }
  }

  private config(track: Mp4VideoTrack): VideoDecoderConfig {
    return {
      codec: track.codec,
      description: track.description,
      codedWidth: track.width,
      codedHeight: track.height,
      optimizeForLatency: true,
    };
  }

  /** Video frame `frame`, owned by the caller. */
  private async decodeFrame(
    frame: number,
    signal: AbortSignal,
  ): Promise<VideoFrame> {
    const track = this.track!;
    const target = this.sampleOfFrame[frame];
    const key = this.keySample(target);
    // Feeding on is cheaper than restarting unless a keyframe lies between.
    if (this.fed < 0 || frame <= this.taken || key > this.fed) {
      this.restart(key);
    }
    // Frames before the target are dropped as they come: a decoder with a
    // bounded surface pool would stall while they stay open.
    this.taken = frame - 1;
    this.dropOutputsBefore(frame);
    while (!this.outputs.has(frame)) {
      if (this.failure) {
        throw this.failure;
      }
      if (signal.aborted) {
        throw abortError();
      }
      const decoder = this.decoder!;
      if (this.fed < track.samples.length && decoder.decodeQueueSize < 2) {
        this.feed(this.fed++);
        if (this.fed === track.samples.length) {
          // The last frames leave the reorder buffer only on flush, after
          // which the decoder needs a keyframe: the next restart feeds one.
          void decoder.flush().catch(() => undefined);
        }
      }
      await this.waitProgress();
    }
    const decoded = this.outputs.get(frame)!;
    this.outputs.delete(frame);
    this.taken = frame;
    return decoded;
  }

  private dropOutputsBefore(frame: number): void {
    for (const [f, other] of this.outputs) {
      if (f < frame) {
        other.close();
        this.outputs.delete(f);
      }
    }
  }

  private keySample(sample: number): number {
    const { samples } = this.track!;
    let key = sample;
    while (key > 0 && !samples[key].key) {
      key--;
    }
    return key;
  }

  private restart(key: number): void {
    this.closeDecoder();
    this.failure = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.decoder !== decoder || frame.timestamp <= this.taken) {
          frame.close();
        } else {
          this.outputs.set(frame.timestamp, frame);
        }
        this.notify();
      },
      error: (error) => {
        if (this.decoder === decoder) {
          this.failure = error;
          this.fed = -1;
        }
        this.notify();
      },
    });
    decoder.addEventListener("dequeue", () => this.notify());
    decoder.configure(this.config(this.track!));
    this.decoder = decoder;
    this.fed = key;
    this.taken = this.track!.samples[key].frame - 1;
  }

  private feed(index: number): void {
    const sample = this.track!.samples[index];
    this.decoder!.decode(
      new EncodedVideoChunk({
        type: sample.key ? "key" : "delta",
        // Video frame numbers: outputs carry them back in display order.
        timestamp: sample.frame,
        data: new Uint8Array(this.data!, sample.offset, sample.size),
      }),
    );
  }

  /** Next output, dequeue or error; a timer for decoders without events. */
  private waitProgress(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, PROGRESS_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.progress = done;
    });
  }

  private notify(): void {
    const progress = this.progress;
    this.progress = null;
    progress?.();
  }

  private closeDecoder(): void {
    if (this.decoder && this.decoder.state !== "closed") {
      this.decoder.close();
    }
    this.decoder = null;
    this.fed = -1;
    for (const frame of this.outputs.values()) {
      frame.close();
    }
    this.outputs.clear();
  }
}
