import { describe, expect, it } from "vitest";
import drawVert from "./shaders/draw.vert.glsl";
import updateFrag from "./shaders/update.frag.glsl";

describe("particle shader invalid-state guards", () => {
  it("respawns invalid particle state in the update shader", () => {
    expect(updateFrag).toContain("invalidNormalizedPosition");
    expect(updateFrag).toContain("invalidWrappedPosition");
    expect(updateFrag).toContain("drop = 1.0");
  });

  it("hides invalid particles before projection in the draw shader", () => {
    expect(drawVert).toContain("invalidNormalizedPosition");
    expect(drawVert).toContain("hideParticle()");
    expect(drawVert).toContain("return;");
  });

  it("validates the full line segment before selecting a draw endpoint", () => {
    expect(drawVert).toContain("vec2 headPos = currPos");
    expect(drawVert).toContain("vec2 tailPos = currPos - offset");
    expect(drawVert).toContain("segmentPx > maxSegmentPx");
    expect(drawVert).toContain("vec2 pos = mix(tailPos, headPos, a_is_curr)");
  });

  it("does not wrap draw-time segment endpoints across the dateline", () => {
    expect(drawVert).not.toContain("pos.x = fract(pos.x)");
    expect(drawVert).toContain("invalidWrappedPosition(headPos)");
    expect(drawVert).toContain("invalidWrappedPosition(tailPos)");
  });
});
