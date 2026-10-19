import { describe, expect, it } from "vitest";
import { nextStoryIndex } from "./navigation";

describe("nextStoryIndex", () => {
  it("moves exactly one scene forward and backward", () => {
    expect(nextStoryIndex(0, 1, 5)).toBe(1);
    expect(nextStoryIndex(2, -1, 5)).toBe(1);
  });

  it("clamps navigation at both ends", () => {
    expect(nextStoryIndex(0, -1, 5)).toBe(0);
    expect(nextStoryIndex(4, 1, 5)).toBe(4);
  });
});
