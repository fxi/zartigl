import {
  geoVideoSecondsForTime,
  geoVideoTimelineValues,
  type GeoVideoManifest,
  type GeoVideoVectorEncoding,
} from "./geovideo";
import type { VectorFieldSource, ZarrChunkFetchResult } from "./types";

/** Decoded u/v planes of one frame, NaN where the static mask is invalid. */
export interface GeoVideoVectorFrame {
  u: Float32Array;
  v: Float32Array;
}

/**
 * Luma codes from browser RGBA output. Browsers expand limited-range luma to
 * full-range RGB (R = (Y - 16) * 255 / 219 for neutral chroma); invert it.
 */
export function lumaCodesFromRgba(
  rgba: Uint8Array,
  colorRange: GeoVideoVectorEncoding["colorRange"],
): Uint8Array {
  const codes = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < codes.length; i++) {
    const r = rgba[i * 4];
    codes[i] = colorRange === "limited" ? Math.round((r * 219) / 255 + 16) : r;
  }
  return codes;
}

/** Code to physical component value, inverse of the renderer quantization. */
export function decodeVectorComponent(
  code: number,
  encoding: Pick<
    GeoVideoVectorEncoding,
    "codeMin" | "codeMax" | "valueDomain" | "transfer"
  >,
): number {
  let s =
    ((code - encoding.codeMin) / (encoding.codeMax - encoding.codeMin)) * 2 - 1;
  s = Math.max(-1, Math.min(1, s));
  if (encoding.transfer === "sqrt") {
    s = Math.sign(s) * s * s;
  }
  return s * encoding.valueDomain;
}

/**
 * Stacked u/v codes (u rows first) to masked component planes.
 * `mask` holds one 8-bit validity value per grid cell.
 */
export function decodeVectorFrame(
  codes: Uint8Array,
  mask: Uint8Array,
  threshold: number,
  encoding: Pick<
    GeoVideoVectorEncoding,
    "codeMin" | "codeMax" | "valueDomain" | "transfer"
  >,
): GeoVideoVectorFrame {
  const n = mask.length;
  if (codes.length !== 2 * n) {
    throw new Error(
      `GeoVideo vector frame has ${codes.length} codes, expected ${2 * n}`,
    );
  }
  const lut = new Float32Array(256);
  for (let code = 0; code < 256; code++) {
    lut[code] = decodeVectorComponent(code, encoding);
  }
  const limit = threshold * 255;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const valid = mask[i] >= limit;
    u[i] = valid ? lut[codes[i]] : NaN;
    v[i] = valid ? lut[codes[n + i]] : NaN;
  }
  return { u, v };
}

/** RGBA pixels of an image or video frame through WebGL, without color management. */
class PixelReader {
  private gl: WebGLRenderingContext | null = null;
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

  private context(): WebGLRenderingContext {
    if (this.gl) {
      return this.gl;
    }
    const canvas = document.createElement("canvas");
    const attributes: WebGLContextAttributes = {
      premultipliedAlpha: false,
      antialias: false,
    };
    const gl: WebGLRenderingContext | null =
      canvas.getContext("webgl2", attributes) ??
      canvas.getContext("webgl", attributes);
    if (!gl) {
      throw new Error("WebGL is required to decode GeoVideo frames");
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

function abortError(): DOMException {
  return new DOMException("GeoVideo frame request was cancelled", "AbortError");
}

function once(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) =>
    target.addEventListener(type, () => resolve(), { once: true }),
  );
}

/**
 * VectorLayer field source backed by a vector-luma GeoVideo: each time step is
 * one video frame, decoded on demand (frame by frame, no playback) into a
 * single chunk covering the whole grid.
 */
export class GeoVideoVectorSource implements VectorFieldSource {
  readonly width: number;
  readonly height: number;
  private readonly manifest: GeoVideoManifest;
  private readonly encoding: GeoVideoVectorEncoding;
  private readonly coords: {
    time: Float64Array;
    vertical: Float32Array;
    latitude: Float32Array;
    longitude: Float32Array;
  };
  private readonly cacheSize: number;
  private readonly reader = new PixelReader();
  private video: HTMLVideoElement | null = null;
  private mask: Uint8Array | null = null;
  private initPromise: Promise<void> | null = null;
  private presented = false;
  private primed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private readonly frames = new Map<number, Promise<GeoVideoVectorFrame>>();

  constructor(
    manifest: GeoVideoManifest,
    options: { cacheSize?: number } = {},
  ) {
    if (manifest.encoding.kind !== "vector-luma") {
      throw new Error("GeoVideoVectorSource requires a vector-luma manifest");
    }
    this.manifest = manifest;
    this.encoding = manifest.encoding;
    this.cacheSize = Math.max(1, options.cacheSize ?? 3);
    this.width = manifest.media.width;
    this.height = manifest.media.height / 2;
    const [west, south, east, north] = manifest.bounds;
    const dx = (east - west) / this.width;
    const dy = (north - south) / this.height;
    this.coords = {
      time: Float64Array.from(geoVideoTimelineValues(manifest)),
      vertical: new Float32Array([0]),
      latitude: Float32Array.from(
        { length: this.height },
        (_, i) => north - (i + 0.5) * dy,
      ),
      longitude: Float32Array.from(
        { length: this.width },
        (_, i) => west + (i + 0.5) * dx,
      ),
    };
  }

  getValueDomain(): number {
    return this.encoding.valueDomain;
  }

  init(): Promise<void> {
    this.initPromise ??= this.load().catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  /** Abort queued frame decodes; frames already decoded stay cached. */
  cancelAll(): void {
    this.epoch++;
    for (const [index, frame] of this.frames) {
      frame.catch(() => this.frames.delete(index));
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

  getCoords(): {
    time: Float64Array;
    vertical: Float32Array;
    latitude: Float32Array;
    longitude: Float32Array;
  } {
    return this.coords;
  }

  getDimensions(): string[] {
    return ["time", "latitude", "longitude"];
  }

  getChunkShape(): number[] {
    return [1, this.height, this.width];
  }

  findDepthIndex(): number {
    return 0;
  }

  findTimeIndex(time: string | number): number {
    const ms = typeof time === "number" ? time : new Date(time).getTime();
    const values = this.coords.time;
    let best = 0;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i] - ms) < Math.abs(values[best] - ms)) {
        best = i;
      }
    }
    return best;
  }

  getChunksForBounds(
    _variable: string,
    timeIdx: number,
    depthIdx: number,
  ): Array<{
    timeIdx: number;
    depthIdx: number;
    latIdx: number;
    lonIdx: number;
    latRange: [number, number];
    lonRange: [number, number];
    latSize: number;
    lonSize: number;
  }> {
    const { latitude, longitude } = this.coords;
    return [
      {
        timeIdx,
        depthIdx,
        latIdx: 0,
        lonIdx: 0,
        latRange: [latitude[0], latitude[this.height - 1]],
        lonRange: [longitude[0], longitude[this.width - 1]],
        latSize: this.height,
        lonSize: this.width,
      },
    ];
  }

  async fetchSpatialChunkResult(
    variable: string,
    selection: { timeIndex: number },
  ): Promise<ZarrChunkFetchResult> {
    const frame = await this.frame(selection.timeIndex);
    return {
      data: variable === "v" ? frame.v : frame.u,
      missing: false,
      url: this.manifest.media.url,
    };
  }

  /** u and v of one time step share a single decode. */
  frame(index: number): Promise<GeoVideoVectorFrame> {
    const cached = this.frames.get(index);
    if (cached) {
      this.frames.delete(index);
      this.frames.set(index, cached);
      return cached;
    }
    const epoch = this.epoch;
    const job = this.queue.then(() => this.decode(index, epoch));
    this.queue = job.catch(() => undefined);
    this.frames.set(index, job);
    job.catch(() => {
      if (this.frames.get(index) === job) {
        this.frames.delete(index);
      }
    });
    while (this.frames.size > this.cacheSize) {
      this.frames.delete(this.frames.keys().next().value!);
    }
    return job;
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
      !this.presented ||
      Math.abs(video.currentTime - seconds) > 1e-3 ||
      video.seeking
    ) {
      const seeked = once(video, "seeked");
      video.currentTime = seconds;
      await seeked;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await Promise.race([once(video, "loadeddata"), once(video, "canplay")]);
    }
    if ("requestVideoFrameCallback" in video) {
      await Promise.race([
        new Promise<void>((resolve) =>
          video.requestVideoFrameCallback(() => resolve()),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
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

  private async decode(
    index: number,
    epoch: number,
  ): Promise<GeoVideoVectorFrame> {
    await this.init();
    const video = this.video;
    const mask = this.mask;
    if (epoch !== this.epoch || !video || !mask) {
      throw abortError();
    }
    const seconds = geoVideoSecondsForTime(
      this.manifest,
      this.coords.time[index],
    );
    await this.presentFrame(video, seconds);
    if (epoch !== this.epoch || video !== this.video) {
      throw abortError();
    }
    let rgba = this.reader.read(video, this.width, this.height * 2);
    if (isBlankReadback(rgba) && !this.primed) {
      await this.primeDecoder(video);
      await this.presentFrame(video, seconds);
      if (epoch !== this.epoch || video !== this.video) {
        throw abortError();
      }
      rgba = this.reader.read(video, this.width, this.height * 2);
    }
    if (isBlankReadback(rgba)) {
      throw new Error("GeoVideo frame could not be read back from the decoder");
    }
    const codes = lumaCodesFromRgba(rgba, this.encoding.colorRange);
    return decodeVectorFrame(
      codes,
      mask,
      this.manifest.mask.threshold,
      this.encoding,
    );
  }
}
