import {
  geoVideoSecondsForTime,
  geoVideoTimelineValues,
  type GeoVideoManifest,
} from "./geovideo";

/**
 * Luma codes from browser RGBA output. Browsers expand limited-range luma to
 * full-range RGB (R = (Y - 16) * 255 / 219 for neutral chroma); invert it.
 */
export function lumaCodesFromRgba(
  rgba: Uint8Array,
  colorRange: GeoVideoManifest["encoding"]["colorRange"],
): Uint8Array {
  const codes = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < codes.length; i++) {
    const r = rgba[i * 4];
    codes[i] = colorRange === "limited" ? Math.round((r * 219) / 255 + 16) : r;
  }
  return codes;
}

/** RGBA pixels of an image or video frame through WebGL, without color management. */
class PixelReader {
  private gl: WebGL2RenderingContext | null = null;
  private texture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;

  read(source: TexImageSource, width: number, height: number): Uint8Array {
    const gl = this.context();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    );
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
  }

  release(): void {
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.texture = null;
    this.framebuffer = null;
  }

  private context(): WebGL2RenderingContext {
    if (this.gl) {
      return this.gl;
    }
    const canvas = document.createElement("canvas");
    const attributes: WebGLContextAttributes = {
      premultipliedAlpha: false,
      antialias: false,
    };
    const gl = canvas.getContext("webgl2", attributes);
    if (!gl) {
      throw new Error("WebGL2 is required to decode GeoVideo frames");
    }
    this.gl = gl;
    this.texture = gl.createTexture();
    this.framebuffer = gl.createFramebuffer();
    return gl;
  }
}

/** Decoded video pixels are opaque; an all-transparent readback means no frame. */
export function isBlankReadback(rgba: Uint8Array): boolean {
  const stride = Math.max(4, Math.floor(rgba.length / 4 / 997) * 4);
  for (let i = 3; i < rgba.length; i += stride) {
    if (rgba[i] !== 0) {
      return false;
    }
  }
  return true;
}

export function abortError(): DOMException {
  return new DOMException("GeoVideo frame request was cancelled", "AbortError");
}

/**
 * `promise`, or an AbortError as soon as `signal` aborts. The work behind
 * `promise` is not stopped: callers sharing it keep waiting for it.
 */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    // The shared work goes on; its outcome is observed, never unhandled.
    promise.catch(() => undefined);
    onAbort?.();
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

/** Options of one frame request. */
export interface GeoVideoFrameRequest {
  /** Abandons this request only; the decode stops once no request needs it. */
  signal?: AbortSignal;
}

/** One time step's decode, shared by the requests waiting for it. */
interface FrameJob<TFrame> {
  readonly index: number;
  readonly controller: AbortController;
  promise: Promise<TFrame>;
  /** Requests still waiting; one without a signal never leaves. */
  waiters: number;
  settled: boolean;
}

function once(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) =>
    target.addEventListener(type, () => resolve(), { once: true }),
  );
}

/** Longest wait for a presented frame, when the browser reports none. */
const PRESENT_TIMEOUT_MS = 250;

/** Next presented video frame, or a timeout; immediate without the API. */
function presentedFrame(video: HTMLVideoElement): Promise<void> {
  if (!("requestVideoFrameCallback" in video)) {
    return Promise.resolve();
  }
  return Promise.race([
    new Promise<void>((resolve) =>
      video.requestVideoFrameCallback(() => resolve()),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, PRESENT_TIMEOUT_MS)),
  ]);
}

/**
 * GeoVideo frames read one time step at a time (seek, no playback): video
 * and static mask loading, luma readback, a serial decode queue, and a small
 * LRU cache of decoded frames. Requests for the same step share one decode;
 * each can be abandoned with its own signal, and the decode is dropped once
 * no request waits for it. cancelAll() aborts every pending decode.
 * Subclasses turn the luma codes of a frame into values.
 */
export abstract class GeoVideoFrameSource<TFrame> {
  /** Grid size; the video stacks `planes` grids vertically. */
  readonly width: number;
  readonly height: number;
  protected readonly manifest: GeoVideoManifest;
  protected readonly times: Float64Array;
  private readonly planes: number;
  private readonly cacheSize: number;
  private readonly reader = new PixelReader();
  private video: HTMLVideoElement | null = null;
  private mask: Uint8Array | null = null;
  private initPromise: Promise<void> | null = null;
  private presented = false;
  private primed = false;
  /** Serializes seeks: the previous decode, settled or not, runs first. */
  private queue: Promise<unknown> = Promise.resolve();
  /** LRU of decoded and pending steps. */
  private readonly frames = new Map<number, FrameJob<TFrame>>();
  /** Pending decodes, including those the LRU already evicted. */
  private readonly pending = new Set<FrameJob<TFrame>>();

  constructor(
    manifest: GeoVideoManifest,
    planes: number,
    options: { cacheSize?: number } = {},
  ) {
    this.manifest = manifest;
    this.planes = planes;
    this.cacheSize = Math.max(1, options.cacheSize ?? 3);
    this.width = manifest.media.width;
    this.height = manifest.media.height / planes;
    this.times = Float64Array.from(geoVideoTimelineValues(manifest));
  }

  /** Codes of the stacked planes and the per-cell mask to frame values. */
  protected abstract decodeCodes(
    codes: Uint8Array,
    mask: Uint8Array,
    threshold: number,
  ): TFrame;

  init(): Promise<void> {
    this.initPromise ??= this.load().catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  /** Abort every pending frame decode; frames already decoded stay cached. */
  cancelAll(): void {
    for (const job of [...this.pending]) {
      this.drop(job);
    }
  }

  /** Release the video element and GL context; a later init() reloads them. */
  release(): void {
    this.cancelAll();
    this.frames.clear();
    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.video = null;
    this.mask = null;
    this.presented = false;
    this.primed = false;
    this.initPromise = null;
    this.reader.release();
  }

  /**
   * One decode per time step, cached and shared by concurrent requests.
   * Aborting `request.signal` rejects this request with an AbortError; the
   * decode goes on while another request waits for it.
   */
  frame(index: number, request: GeoVideoFrameRequest = {}): Promise<TFrame> {
    const { signal } = request;
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    let job = this.frames.get(index);
    if (job) {
      this.frames.delete(index);
      this.frames.set(index, job);
    } else {
      job = this.enqueue(index);
    }
    if (job.settled) {
      return job.promise;
    }
    const waiting = job;
    waiting.waiters++;
    return abortable(waiting.promise, signal, () => this.leave(waiting));
  }

  private enqueue(index: number): FrameJob<TFrame> {
    const controller = new AbortController();
    // A decode abandoned while queued is skipped.
    const run = this.queue.then(() =>
      controller.signal.aborted
        ? Promise.reject(abortError())
        : this.decode(index, controller.signal),
    );
    // The next seek waits for this one, even once its requests left.
    this.queue = run.catch(() => undefined);
    const job: FrameJob<TFrame> = {
      index,
      controller,
      promise: abortable(run, controller.signal),
      waiters: 0,
      settled: false,
    };
    this.pending.add(job);
    job.promise.then(
      () => {
        job.settled = true;
        this.pending.delete(job);
      },
      () => {
        job.settled = true;
        this.pending.delete(job);
        if (this.frames.get(index) === job) {
          this.frames.delete(index);
        }
      },
    );
    this.frames.set(index, job);
    while (this.frames.size > this.cacheSize) {
      this.frames.delete(this.frames.keys().next().value!);
    }
    return job;
  }

  /** A request left; drop the decode when it was the last one waiting. */
  private leave(job: FrameJob<TFrame>): void {
    job.waiters--;
    if (job.waiters <= 0 && !job.settled) {
      this.drop(job);
    }
  }

  private drop(job: FrameJob<TFrame>): void {
    job.controller.abort();
    this.pending.delete(job);
    if (this.frames.get(job.index) === job) {
      this.frames.delete(job.index);
    }
  }

  private async load(): Promise<void> {
    const [mask] = await Promise.all([this.loadMask(), this.loadVideo()]);
    this.mask = mask;
  }

  private async loadMask(): Promise<Uint8Array> {
    const { url, width, height } = this.manifest.mask;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error(`Failed to load GeoVideo mask: ${url}`);
    }
    if (image.naturalWidth !== width || image.naturalHeight !== height) {
      throw new Error(
        `GeoVideo mask dimensions ${image.naturalWidth}x${image.naturalHeight} do not match manifest ${width}x${height}`,
      );
    }
    const rgba = this.reader.read(image, width, height);
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = rgba[i * 4];
    }
    return mask;
  }

  private async loadVideo(): Promise<void> {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    // Fetch only the byte ranges of the frames actually requested.
    video.preload = "metadata";
    video.src = this.manifest.media.url;
    this.video = video;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), {
        once: true,
      });
      video.addEventListener(
        "error",
        () =>
          reject(
            new Error(
              `Failed to load GeoVideo media: ${this.manifest.media.url}`,
            ),
          ),
        { once: true },
      );
    });
  }

  /** Seek to a frame and wait until it is presented. */
  private async presentFrame(
    video: HTMLVideoElement,
    seconds: number,
  ): Promise<void> {
    if (
      this.presented &&
      Math.abs(video.currentTime - seconds) <= 1e-3 &&
      !video.seeking
    ) {
      return;
    }
    // Registered before the seek: the frame can be presented before
    // `seeked` fires, and a callback added after it would wait for the
    // timeout.
    const presented = presentedFrame(video);
    const seeked = once(video, "seeked");
    video.currentTime = seconds;
    await seeked;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await Promise.race([once(video, "loadeddata"), once(video, "canplay")]);
    }
    await presented;
    this.presented = true;
  }

  /**
   * Some mobile browsers expose no decoded pixels to WebGL until playback
   * started once. A muted play/pause primes the decoder, only when needed:
   * playback would otherwise buffer far beyond the requested frame.
   */
  private async primeDecoder(video: HTMLVideoElement): Promise<void> {
    this.primed = true;
    try {
      await video.play();
    } catch {
      // Autoplay refusal: nothing else to try.
    }
    video.pause();
    this.presented = false;
  }

  /**
   * Seek, read back and decode one step. `signal` aborts it between steps;
   * a seek already started completes first, keeping the queue serial.
   */
  protected async decode(index: number, signal: AbortSignal): Promise<TFrame> {
    if (signal.aborted) {
      throw abortError();
    }
    await this.init();
    const video = this.video;
    const mask = this.mask;
    if (signal.aborted || !video || !mask) {
      throw abortError();
    }
    const seconds = geoVideoSecondsForTime(this.manifest, this.times[index]);
    await this.presentFrame(video, seconds);
    if (signal.aborted || video !== this.video) {
      throw abortError();
    }
    const rows = this.height * this.planes;
    let rgba = this.reader.read(video, this.width, rows);
    if (isBlankReadback(rgba) && !this.primed) {
      await this.primeDecoder(video);
      await this.presentFrame(video, seconds);
      if (signal.aborted || video !== this.video) {
        throw abortError();
      }
      rgba = this.reader.read(video, this.width, rows);
    }
    if (isBlankReadback(rgba)) {
      throw new Error("GeoVideo frame could not be read back from the decoder");
    }
    const codes = lumaCodesFromRgba(rgba, this.manifest.encoding.colorRange);
    return this.decodeCodes(codes, mask, this.manifest.mask.threshold);
  }
}
