/** Shareable position in a story: the scene and whether playback holds. */
export interface StoryHashState {
  scene?: string;
  paused?: boolean;
}

/** Read `#s=<scene id>&paused=1`; unknown or missing fields stay undefined. */
export function parseStoryHash(hash: string): StoryHashState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const state: StoryHashState = {};
  const scene = params.get("s");
  if (scene) {
    state.scene = scene;
  }
  const paused = params.get("paused");
  if (paused === "1" || paused === "0") {
    state.paused = paused === "1";
  }
  return state;
}

/** Url hash, without the leading "#", for a scene and its play state. */
export function storyHash(scene: string, paused: boolean): string {
  const params = new URLSearchParams({ s: scene });
  if (paused) {
    params.set("paused", "1");
  }
  return params.toString();
}
