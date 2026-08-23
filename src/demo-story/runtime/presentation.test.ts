import { describe, expect, it } from "vitest";
import storyJson from "../story.json";
import { advanceStorySequence, sceneShowsTime, StoryTimePresentation } from "./presentation";
import type { StoryDocument } from "./types";

const story = storyJson as StoryDocument;

describe("story presentation", () => {
  it("shows time only when the active copy opts in", () => {
    expect(sceneShowsTime(story.scenes.find((scene) => scene.id === "intro")!)).toBe(false);
    expect(sceneShowsTime(story.scenes.find((scene) => scene.id === "arctic")!)).toBe(true);
    expect(sceneShowsTime(story.scenes.find((scene) => scene.id === "mayotte")!)).toBe(true);
    expect(sceneShowsTime(story.scenes.find((scene) => scene.id === "outro")!)).toBe(false);
  });

  it("rejects a late dataset time after entering a timeless scene", () => {
    const presentation = new StoryTimePresentation();
    presentation.setScene(story.scenes.find((scene) => scene.id === "arctic")!);
    expect(presentation.accept(Date.parse("2024-12-14T12:00:00Z"))).not.toBeNull();

    presentation.setScene(story.scenes.find((scene) => scene.id === "outro")!);
    expect(presentation.visible).toBe(false);
    expect(presentation.accept(Date.parse("2024-12-14T15:00:00Z"))).toBeNull();
  });

  it("loops forward from the last frame to the first", () => {
    const visited: number[] = [0];
    let state: { index: number; direction: 1 | -1 } = { index: 0, direction: 1 };
    for (let step = 0; step < 8; step++) {
      state = advanceStorySequence(state.index, state.direction, 8, "loop");
      visited.push(state.index);
    }
    expect(visited).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);
    expect(state.direction).toBe(1);
  });
});
