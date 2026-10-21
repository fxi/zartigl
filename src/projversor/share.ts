import { mergeStyles, parseLayerStyle, type LayerStyleInput } from "../catalog";
import { colorGradeToGrade, type ColorGrade } from "../engine";

/** Everything needed to reproduce the displayed view. */
export interface ShareState {
  /** zartigl catalog entry id. */
  layer: string;
  /** Playhead, epoch ms. */
  time: number;
  /** Projection preset id. */
  preset: string;
  rotate: [number, number, number];
  zoom: number;
  playing: boolean;
  /** Playback speed multiplier. */
  speed: number;
  /** Scalar entry id coloring the particles; "" colors them by speed. */
  tint: string;
  /** Style override over the layer's own: palette, particles, raster. */
  style?: LayerStyleInput;
}

/** Flat fields of the first format, moved to `style`. */
export interface LegacyShareState {
  /** @deprecated Use `style.palette`. */
  palette?: string;
  /** @deprecated Use `style.particles.grade`. */
  grade?: ColorGrade;
}

const round = (value: number) => Number(value.toFixed(3));

/** Readable url hash, without the leading "#". */
export function encodeShare(state: ShareState): string {
  const params = new URLSearchParams({
    l: state.layer,
    t: new Date(state.time).toISOString(),
    p: state.preset,
    r: state.rotate.map(round).join(","),
    z: String(round(state.zoom)),
    play: state.playing ? "1" : "0",
    s: String(state.speed),
    k: state.tint,
  });
  if (state.style && Object.keys(state.style).length) {
    params.set("st", JSON.stringify(state.style));
  }
  return params.toString();
}

/** A shared style, or undefined when it is malformed. */
function parseStyle(text: string | null): LayerStyleInput | undefined {
  if (text === null) {
    return undefined;
  }
  try {
    return parseLayerStyle(JSON.parse(text), "st");
  } catch {
    return undefined;
  }
}

/** The style of the first format's palette (`c`) and grade (`g`). */
function legacyStyle(params: URLSearchParams): LayerStyleInput {
  const grade = (params.get("g") ?? "").split(",").map(Number);
  const [exposure, contrast, saturation, highlights] = grade;
  return mergeStyles({
    palette: params.get("c") || undefined,
    particles: {
      grade:
        grade.length === 4 && grade.every(Number.isFinite)
          ? colorGradeToGrade({ exposure, contrast, saturation, highlights })
          : undefined,
    },
  });
}

/**
 * Valid fields of a hash written by {@link encodeShare}, or by the first
 * format; the caller checks the layer, preset and palette ids, the speed,
 * and the style against the layer.
 */
export function decodeShare(hash: string): Partial<ShareState> {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const state: Partial<ShareState> = {};
  const layer = params.get("l");
  if (layer) {
    state.layer = layer;
  }
  const preset = params.get("p");
  if (preset) {
    state.preset = preset;
  }
  const time = Date.parse(params.get("t") ?? "");
  if (Number.isFinite(time)) {
    state.time = time;
  }
  const rotate = (params.get("r") ?? "").split(",").map(Number);
  if (rotate.length === 3 && rotate.every(Number.isFinite)) {
    state.rotate = rotate as [number, number, number];
  }
  const zoom = Number(params.get("z") ?? "");
  if (params.has("z") && Number.isFinite(zoom) && zoom > 0) {
    state.zoom = zoom;
  }
  const speed = Number(params.get("s") ?? "");
  if (params.has("s") && Number.isFinite(speed) && speed > 0) {
    state.speed = speed;
  }
  const tint = params.get("k");
  if (tint !== null) {
    state.tint = tint;
  }
  const style = mergeStyles(legacyStyle(params), parseStyle(params.get("st")));
  if (Object.keys(style).length) {
    state.style = style;
  }
  const play = params.get("play");
  if (play === "0" || play === "1") {
    state.playing = play === "1";
  }
  return state;
}
