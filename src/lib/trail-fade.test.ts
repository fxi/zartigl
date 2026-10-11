import { describe, expect, it } from "vitest";
import { TrailFade, fadeToFrames, fadeToOpacity } from "./trail-fade";

describe("trail fade", () => {
  it("maps fade geometrically to 20–600 frames, clamped", () => {
    expect(fadeToFrames(0)).toBeCloseTo(20, 9);
    expect(fadeToFrames(1)).toBeCloseTo(600, 9);
    expect(fadeToFrames(0.5)).toBeCloseTo(Math.sqrt(20 * 600), 9);
    expect(fadeToFrames(-1)).toBe(fadeToFrames(0));
    expect(fadeToFrames(2)).toBe(fadeToFrames(1));
  });

  it("dims a trail to 1/e after its length in frames", () => {
    for (const fade of [0, 0.7, 1]) {
      expect(fadeToOpacity(fade) ** fadeToFrames(fade)).toBeCloseTo(
        Math.exp(-1),
        9,
      );
    }
  });
});

describe("TrailFade", () => {
  it("eases to a short retention while moving, then back", () => {
    const fade = new TrailFade(0.99);
    expect(fade.value(0)).toBe(0.99);
    fade.setMoving(true, 0);
    expect(fade.value(60)).toBeCloseTo(0.895, 9);
    expect(fade.value(120)).toBe(0.8);
    fade.setMoving(false, 200);
    expect(fade.value(200)).toBe(0.8);
    expect(fade.value(500)).toBe(0.99);
  });

  it("applies a new base at rest, and after the camera settles", () => {
    const fade = new TrailFade(0.99);
    fade.setBase(0.95);
    expect(fade.value(0)).toBe(0.95);
    fade.setMoving(true, 0);
    fade.setBase(0.9);
    expect(fade.value(1000)).toBe(0.8);
    fade.setMoving(false, 1000);
    expect(fade.value(1300)).toBe(0.9);
  });

  it("applies a new base set while easing back after a move", () => {
    const fade = new TrailFade(0.99);
    fade.setMoving(true, 0);
    fade.setMoving(false, 200);
    fade.setBase(0.95);
    expect(fade.value(250)).toBe(0.95);
    expect(fade.value(1000)).toBe(0.95);
  });
});
