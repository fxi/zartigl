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
  /** Palette id. */
  palette: string;
}

const round = (value: number) => Number(value.toFixed(3));

/** Readable url hash, without the leading "#". */
export function encodeShare(state: ShareState): string {
  return new URLSearchParams({
    l: state.layer,
    t: new Date(state.time).toISOString(),
    p: state.preset,
    r: state.rotate.map(round).join(","),
    z: String(round(state.zoom)),
    play: state.playing ? "1" : "0",
    s: String(state.speed),
    c: state.palette,
  }).toString();
}

/**
 * Valid fields of a hash written by {@link encodeShare}; the caller checks the
 * layer, preset and palette ids and the speed against its choices.
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
  const palette = params.get("c");
  if (palette) {
    state.palette = palette;
  }
  const play = params.get("play");
  if (play === "0" || play === "1") {
    state.playing = play === "1";
  }
  return state;
}
