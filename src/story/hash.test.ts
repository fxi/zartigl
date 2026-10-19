import { describe, expect, it } from "vitest";
import { parseStoryHash, storyHash } from ".";

describe("story hash", () => {
  it("round-trips a scene and its play state", () => {
    expect(parseStoryHash(`#${storyHash("arctic", true)}`)).toEqual({
      scene: "arctic",
      paused: true,
    });
    expect(storyHash("intro", false)).toBe("s=intro");
    expect(parseStoryHash("s=intro")).toEqual({ scene: "intro" });
  });

  it("ignores empty or malformed fields", () => {
    expect(parseStoryHash("")).toEqual({});
    expect(parseStoryHash("#s=&paused=yes")).toEqual({});
  });
});
