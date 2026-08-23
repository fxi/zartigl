import type { StoryScene } from "./types";

export function sceneShowsTime(scene: StoryScene): boolean {
  return scene.blocks.some((block) => block.type === "copy" && block.showTime === true);
}

export class StoryTimePresentation {
  private enabled = false;

  get visible(): boolean { return this.enabled; }

  setScene(scene: StoryScene): void {
    this.enabled = sceneShowsTime(scene);
  }

  accept(time: number): number | null {
    return this.enabled && Number.isFinite(time) ? time : null;
  }
}

export function advanceStorySequence(
  index: number,
  direction: 1 | -1,
  length: number,
  mode: "loop" | "ping-pong",
): { index: number; direction: 1 | -1 } {
  if (length <= 1) return { index: 0, direction: 1 };
  const next = index + direction;
  if (next >= 0 && next < length) return { index: next, direction };
  if (mode === "loop") return { index: direction === 1 ? 0 : length - 1, direction };
  const nextDirection = direction === 1 ? -1 : 1;
  return { index: index + nextDirection, direction: nextDirection };
}
