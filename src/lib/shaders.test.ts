import { describe, expect, it } from "vitest";
import drawVert from "./shaders/draw.vert.glsl";
import drawFrag from "./shaders/draw.frag.glsl";
import updateFrag from "./shaders/update.frag.glsl";

describe("particle shader invalid-state guards", () => {
  it("respawns invalid particle state in the update shader", () => {
    expect(updateFrag).toContain("invalidNormalizedPosition");
    expect(updateFrag).toContain("invalidWrappedPosition");
    expect(updateFrag).toContain("drop = 1.0");
  });

  it("supports float particle state with an RGBA8-packed fallback", () => {
    expect(updateFrag).toContain("USE_FLOAT_STATE");
    expect(drawVert).toContain("USE_FLOAT_STATE");
    expect(updateFrag).toContain("vec2 pos = encoded.rg");
    expect(updateFrag).toContain("gl_FragColor = vec4(newPos, 0.0, 1.0)");
    expect(updateFrag).toContain("const float MIN_STEP = 1.0 / 65025.0");
    expect(updateFrag).toContain("floor(newPos.x * 255.0) / 255.0");
    expect(drawVert).toContain("encoded.r + encoded.g / 255.0");
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

  it("uses the palette path with automatic raster-particle contrast only", () => {
    expect(drawFrag).not.toContain("u_particle_color_mode");
    expect(drawFrag).toContain("texture2D(u_color_ramp");
    expect(drawFrag).toContain("u_particle_contrast > 0.5");
  });
});
