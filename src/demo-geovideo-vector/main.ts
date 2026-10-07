import maplibregl from "maplibre-gl";
import type { Map as MaplibreMap } from "maplibre-gl";
import { VectorLayer } from "../lib";
import type { ZarrChunkFetchResult, ZarrSource } from "../lib";
import type { RenderMode } from "../lib/ParticleSimulation";
import {
  decodeVectorComponent,
  lumaCodesFromRgba,
} from "../lib/GeoVideoVectorSource";

/**
 * Vector GeoVideo lab: the same particle renderer fed by the float reference
 * (left) and by a browser-decoded candidate (right). Assets are produced by
 * scripts/geovideo/vector_lab.py export.
 */

interface Variant {
  id: string;
  kind: "png" | "video";
  scheme: "linear" | "sqrt";
  label: string;
  kbPerFrame: number;
  pattern?: string;
  file?: string;
}

interface Meta {
  dataset: string;
  label: string;
  unit: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  timesMs: number[];
  latitude: number[];
  longitude: number[];
  domain: number;
  codeMin: number;
  codeMax: number;
  variants: Variant[];
}

interface Frame {
  u: Float32Array;
  v: Float32Array;
  /** Luma codes as decoded by the browser (u rows then v rows); absent for the reference. */
  codes?: Uint8Array;
}

type FrameLoader = (k: number) => Promise<Frame>;

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element ${selector}`);
  }
  return element;
}

const elDataset = required<HTMLSelectElement>("#dataset");
const elVariant = required<HTMLSelectElement>("#variant");
const elTime = required<HTMLInputElement>("#time");
const elTimeLabel = required<HTMLOutputElement>("#time-label");
const elRenderMode = required<HTMLSelectElement>("#render-mode");
const elDensity = required<HTMLInputElement>("#density");
const elCandidateLabel = required<HTMLElement>("#candidate-label");
const elStats = required<HTMLElement>("#stats");

function mapStyle(): string {
  const token = import.meta.env.MAPTILER_TOKEN;
  return token
    ? `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${token}`
    : "https://demotiles.maplibre.org/style.json";
}

// ── Browser decoding ────────────────────────────────────────────────────

/** Reads the RGBA pixels of an image or video frame through WebGL, without color management. */
class PixelReader {
  private readonly gl: WebGL2RenderingContext;
  private readonly texture: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;

  constructor() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false });
    if (!gl) {
      throw new Error("WebGL2 is required");
    }
    this.gl = gl;
    this.texture = gl.createTexture()!;
    this.framebuffer = gl.createFramebuffer()!;
  }

  read(
    source: TexImageSource,
    width: number,
    height: number,
  ): Uint8Array<ArrayBuffer> {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
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
}

const reader = new PixelReader();

function dequantize(
  code: number,
  meta: Meta,
  scheme: Variant["scheme"],
): number {
  return decodeVectorComponent(code, {
    codeMin: meta.codeMin,
    codeMax: meta.codeMax,
    valueDomain: meta.domain,
    transfer: scheme,
  });
}

function quantize(
  value: number,
  meta: Meta,
  scheme: Variant["scheme"],
): number {
  let s = Math.max(-1, Math.min(1, value / meta.domain));
  if (scheme === "sqrt") {
    s = Math.sign(s) * Math.sqrt(Math.abs(s));
  }
  return Math.round(
    meta.codeMin + ((s + 1) / 2) * (meta.codeMax - meta.codeMin),
  );
}

/** Converts decoded luma codes to u/v, masked with the reference land/ice mask. */
function codesToFrame(
  codes: Uint8Array,
  meta: Meta,
  scheme: Variant["scheme"],
  ref: Frame,
): Frame {
  const n = meta.width * meta.height;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const valid = Number.isFinite(ref.u[i]);
    u[i] = valid ? dequantize(codes[i], meta, scheme) : NaN;
    v[i] = valid ? dequantize(codes[n + i], meta, scheme) : NaN;
  }
  return { u, v, codes };
}

/**
 * Float reference clamped to the encoding domain: the renderer normalizes speed
 * and color on the frame min/max, so unclamped outliers would darken the
 * reference and hide the codec difference behind a normalization difference.
 */
function refLoader(meta: Meta): FrameLoader {
  const n = meta.width * meta.height;
  return async (k) => {
    const response = await fetch(
      `./${meta.dataset}/ref/frame_${String(k).padStart(2, "0")}.bin`,
    );
    const values = new Float32Array(await response.arrayBuffer());
    for (let i = 0; i < values.length; i++) {
      values[i] = Math.max(-meta.domain, Math.min(meta.domain, values[i]));
    }
    return { u: values.subarray(0, n), v: values.subarray(n) };
  };
}

function pngLoader(
  meta: Meta,
  variant: Variant,
  ref: FrameLoader,
): FrameLoader {
  const n = meta.width * meta.height;
  return async (k) => {
    const image = new Image();
    image.src = `./${meta.dataset}/${variant.pattern!.replace("{k}", String(k).padStart(2, "0"))}`;
    await image.decode();
    const rgba = reader.read(image, meta.width, meta.height * 2);
    const codes = new Uint8Array(2 * n);
    for (let i = 0; i < 2 * n; i++) {
      codes[i] = rgba[i * 4];
    }
    return codesToFrame(codes, meta, variant.scheme, await ref(k));
  };
}

function videoLoader(
  meta: Meta,
  variant: Variant,
  ref: FrameLoader,
): FrameLoader {
  const n = meta.width * meta.height;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = `./${meta.dataset}/${variant.file}`;
  const ready = new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener(
      "error",
      () => reject(new Error(`Cannot decode ${variant.file}`)),
      { once: true },
    );
  });
  // Seeks are serialized: one <video> element serves one frame at a time.
  let queue: Promise<unknown> = Promise.resolve();

  const seek = async (k: number): Promise<Uint8Array> => {
    await ready;
    const seeked = new Promise<void>((resolve) =>
      video.addEventListener("seeked", () => resolve(), { once: true }),
    );
    video.currentTime = (k + 0.5) / meta.fps;
    await seeked;
    if ("requestVideoFrameCallback" in video) {
      await Promise.race([
        new Promise<void>((resolve) =>
          video.requestVideoFrameCallback(() => resolve()),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
    return lumaCodesFromRgba(
      reader.read(video, meta.width, meta.height * 2),
      "limited",
    );
  };

  return async (k) => {
    const job = queue.then(() => seek(k));
    queue = job.catch(() => undefined);
    const codes = await job;
    return codesToFrame(codes, meta, variant.scheme, await ref(k));
  };
}

function cached(loader: FrameLoader): FrameLoader {
  const frames = new Map<number, Promise<Frame>>();
  return (k) => {
    if (!frames.has(k)) {
      frames.set(k, loader(k));
    }
    return frames.get(k)!;
  };
}

// ── Fake Zarr source: one chunk covering the whole grid ─────────────────

function frameSource(meta: Meta, loader: FrameLoader): ZarrSource {
  const coords = {
    time: Float64Array.from(meta.timesMs),
    vertical: new Float32Array([0]),
    latitude: Float32Array.from(meta.latitude),
    longitude: Float32Array.from(meta.longitude),
  };
  const source = {
    init: async () => undefined,
    cancelAll: () => undefined,
    getCoords: () => coords,
    getDimensions: () => ["time", "latitude", "longitude"],
    getChunkShape: () => [1, meta.height, meta.width],
    findDepthIndex: () => 0,
    findTimeIndex: (time: string | number) => {
      const ms = typeof time === "number" ? time : new Date(time).getTime();
      let best = 0;
      meta.timesMs.forEach((t, i) => {
        if (Math.abs(t - ms) < Math.abs(meta.timesMs[best] - ms)) {
          best = i;
        }
      });
      return best;
    },
    getChunksForBounds: (
      _variable: string,
      timeIdx: number,
      depthIdx: number,
    ) => [
      {
        timeIdx,
        depthIdx,
        latIdx: 0,
        lonIdx: 0,
        latRange: [meta.latitude[0], meta.latitude[meta.height - 1]],
        lonRange: [meta.longitude[0], meta.longitude[meta.width - 1]],
        latSize: meta.height,
        lonSize: meta.width,
      },
    ],
    fetchSpatialChunkResult: async (
      variable: string,
      selection: { timeIndex: number },
    ): Promise<ZarrChunkFetchResult> => {
      const frame = await loader(selection.timeIndex);
      return {
        data: variable === "u" ? frame.u : frame.v,
        missing: false,
        url: "",
      };
    },
  };
  return source as unknown as ZarrSource;
}

// ── Statistics ──────────────────────────────────────────────────────────

function percentile(sorted: Float32Array, p: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

function compare(
  meta: Meta,
  variant: Variant,
  ref: Frame,
  candidate: Frame,
): string {
  const n = meta.width * meta.height;
  const angles: number[] = [];
  let codeErrorSum = 0;
  let codeErrorMax = 0;
  let codeExact = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ref.u[i])) {
      continue;
    }
    const a = Math.atan2(ref.u[i], ref.v[i]);
    const b = Math.atan2(candidate.u[i], candidate.v[i]);
    angles.push(Math.abs(((((b - a) * 180) / Math.PI + 540) % 360) - 180));
    if (candidate.codes) {
      for (const [value, code] of [
        [ref.u[i], candidate.codes[i]],
        [ref.v[i], candidate.codes[n + i]],
      ]) {
        const error = Math.abs(code - quantize(value, meta, variant.scheme));
        codeErrorSum += error;
        codeErrorMax = Math.max(codeErrorMax, error);
        codeExact += error === 0 ? 1 : 0;
        count++;
      }
    }
  }
  const sorted = Float32Array.from(angles).sort();
  const lines = [
    `${variant.label} · ${variant.kbPerFrame.toFixed(0)} kB/frame (float32 reference ${((2 * n * 4) / 1e6).toFixed(1)} MB/frame)`,
    `angle error vs reference: median ${percentile(sorted, 50).toFixed(2)}° · p95 ${percentile(sorted, 95).toFixed(2)}° · p99 ${percentile(sorted, 99).toFixed(2)}°`,
  ];
  if (count) {
    lines.push(
      `browser-decoded codes vs expected: exact ${((100 * codeExact) / count).toFixed(1)}% · mean |err| ${(codeErrorSum / count).toFixed(3)} · max ${codeErrorMax}`,
    );
  }
  return lines.join("\n");
}

// ── App ─────────────────────────────────────────────────────────────────

const mapRef = new maplibregl.Map({
  container: "map-ref",
  style: mapStyle(),
  center: [-30, 0],
  zoom: 1.4,
  renderWorldCopies: true,
});
const mapCandidate = new maplibregl.Map({
  container: "map-candidate",
  style: mapStyle(),
  center: [-30, 0],
  zoom: 1.4,
  renderWorldCopies: true,
});

let syncing = false;
function sync(from: MaplibreMap, to: MaplibreMap): void {
  from.on("move", () => {
    if (syncing) {
      return;
    }
    syncing = true;
    to.jumpTo({
      center: from.getCenter(),
      zoom: from.getZoom(),
      bearing: from.getBearing(),
      pitch: from.getPitch(),
    });
    syncing = false;
  });
}
sync(mapRef, mapCandidate);
sync(mapCandidate, mapRef);

const state: {
  meta?: Meta;
  ref?: FrameLoader;
  candidates: Map<string, FrameLoader>;
  layerRef?: VectorLayer;
  layerCandidate?: VectorLayer;
  statsRequest: number;
} = { candidates: new Map(), statsRequest: 0 };

function createLayer(
  id: string,
  meta: Meta,
  loader: FrameLoader,
  time: number,
): VectorLayer {
  return new VectorLayer({
    id,
    source: "",
    zarrSource: frameSource(meta, loader),
    variableU: "u",
    variableV: "v",
    unit: meta.unit,
    time,
    renderMode: elRenderMode.value as RenderMode,
    particleDensity: Number(elDensity.value),
  });
}

function replaceLayer(
  map: MaplibreMap,
  current: VectorLayer | undefined,
  next: VectorLayer,
): VectorLayer {
  if (current && map.getLayer(current.id)) {
    map.removeLayer(current.id);
  }
  map.addLayer(next);
  return next;
}

function currentTime(): number {
  return state.meta!.timesMs[Number(elTime.value)];
}

function candidateLoader(variant: Variant): FrameLoader {
  if (!state.candidates.has(variant.id)) {
    const meta = state.meta!;
    const loader =
      variant.kind === "png"
        ? pngLoader(meta, variant, state.ref!)
        : videoLoader(meta, variant, state.ref!);
    state.candidates.set(variant.id, cached(loader));
  }
  return state.candidates.get(variant.id)!;
}

function selectedVariant(): Variant {
  return state.meta!.variants.find(
    (variant) => variant.id === elVariant.value,
  )!;
}

async function updateStats(): Promise<void> {
  const request = ++state.statsRequest;
  const variant = selectedVariant();
  const k = Number(elTime.value);
  elStats.textContent = `Decoding ${variant.label}…`;
  try {
    const [ref, candidate] = await Promise.all([
      state.ref!(k),
      candidateLoader(variant)(k),
    ]);
    if (request === state.statsRequest) {
      elStats.textContent = compare(state.meta!, variant, ref, candidate);
    }
  } catch (error) {
    if (request === state.statsRequest) {
      elStats.textContent = `Error: ${(error as Error).message}`;
    }
  }
}

function showCandidate(): void {
  const meta = state.meta!;
  const variant = selectedVariant();
  elCandidateLabel.textContent = `Candidate · ${variant.label}`;
  state.layerCandidate = replaceLayer(
    mapCandidate,
    state.layerCandidate,
    createLayer(
      `candidate-${variant.id}`,
      meta,
      candidateLoader(variant),
      currentTime(),
    ),
  );
  void updateStats();
}

async function loadDataset(name: string): Promise<void> {
  const meta = (await (await fetch(`./${name}/meta.json`)).json()) as Meta;
  state.meta = meta;
  state.ref = cached(refLoader(meta));
  state.candidates.clear();
  elVariant.replaceChildren(
    ...meta.variants.map(
      (variant) =>
        new Option(
          `${variant.label} · ${variant.kbPerFrame.toFixed(0)} kB`,
          variant.id,
        ),
    ),
  );
  const preferred = meta.variants.find(
    (variant) => variant.id === "sqrt_h264_crf14",
  );
  elVariant.value = (preferred ?? meta.variants[0]).id;
  elTime.max = String(meta.frames - 1);
  elTime.value = "0";
  updateTimeLabel();
  state.layerRef = replaceLayer(
    mapRef,
    state.layerRef,
    createLayer(`ref-${name}`, meta, state.ref, currentTime()),
  );
  showCandidate();
}

function updateTimeLabel(): void {
  elTimeLabel.textContent = `${new Date(currentTime()).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function layers(): VectorLayer[] {
  return [state.layerRef, state.layerCandidate].filter(
    (layer): layer is VectorLayer => layer != null,
  );
}

elDataset.addEventListener("change", () => void loadDataset(elDataset.value));
elVariant.addEventListener("change", showCandidate);
elTime.addEventListener("input", () => {
  updateTimeLabel();
  for (const layer of layers()) {
    layer.setTime(currentTime());
  }
  void updateStats();
});
elRenderMode.addEventListener("change", () => {
  for (const layer of layers()) {
    layer.setRenderMode(elRenderMode.value as RenderMode);
  }
});
elDensity.addEventListener("input", () => {
  for (const layer of layers()) {
    layer.setParticleDensity(Number(elDensity.value));
  }
});

async function start(): Promise<void> {
  await Promise.all(
    [mapRef, mapCandidate].map(
      (map) =>
        new Promise<void>((resolve) => map.once("load", () => resolve())),
    ),
  );
  const { datasets } = (await (await fetch("./index.json")).json()) as {
    datasets: string[];
  };
  elDataset.replaceChildren(...datasets.map((name) => new Option(name, name)));
  elDataset.value = datasets.includes("swell") ? "swell" : datasets[0];
  await loadDataset(elDataset.value);
}

start().catch((error: unknown) => {
  elStats.textContent = `Error: ${(error as Error).message}`;
});
