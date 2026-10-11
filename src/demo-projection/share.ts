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
  }).toString();
}

/**
 * Valid fields of a hash written by {@link encodeShare}; the caller checks the
 * layer and preset ids.
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
  const play = params.get("play");
  if (play === "0" || play === "1") {
    state.playing = play === "1";
  }
  return state;
}
