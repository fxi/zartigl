import { describe, expect, it } from "vitest";
import drawVert from "./shaders/draw.vert.glsl";
import drawFrag from "./shaders/draw.frag.glsl";
import fadeFrag from "./shaders/fade.frag.glsl";
import compositeFrag from "./shaders/composite.frag.glsl";
import updateFrag from "./shaders/update.frag.glsl";
import gridFrag from "./shaders/grid.frag.glsl";
import gridGlobeFrag from "./shaders/grid_globe.frag.glsl";
import geoVideoFrag from "./shaders/geovideo.frag.glsl";

describe("particle shader invalid-state guards", () => {
  it("combines buffered GeoVideo color with its stable mask texture", () => {
    expect(geoVideoFrag).toContain("uniform sampler2D u_color");
    expect(geoVideoFrag).toContain("uniform sampler2D u_mask");
    expect(geoVideoFrag).toContain("texture2D(u_mask, uv).r");
    expect(geoVideoFrag).toContain("alpha * u_opacity");
    expect(geoVideoFrag).toContain("u_scalar_luma");
    expect(geoVideoFrag).toContain("u_code_range");
    expect(geoVideoFrag).toContain("u_value_range");
    expect(geoVideoFrag).toContain("u_color_domain");
    expect(geoVideoFrag).toContain("texture2D(u_color_ramp");
  });
  it("fades trail alpha only, so fading trails keep their color", () => {
    expect(fadeFrag).toContain(
      "float alpha = floor(color.a * 255.0 * u_opacity) / 255.0",
    );
    expect(fadeFrag).not.toContain("color.rgb * 255.0 * u_opacity");
    expect(fadeFrag).toContain("step(1.0 / 255.0, alpha)");
  });

  it("wraps particle bounds that cross the dateline", () => {
    expect(updateFrag).toContain("fract(newPos.x - u_bounds.x)");
    expect(updateFrag).toContain(
      "fract(mix(u_bounds.x, u_bounds.z, draw(RESPAWN_X)))",
    );
  });

  it("draws drops, respawns and sub-pixel steps from the integer hash", () => {
    expect(updateFrag).toContain("#version 300 es");
    expect(updateFrag).toContain("float random(uvec3 v)");
    expect(updateFrag).toContain("uniform uint u_frame");
    expect(updateFrag).not.toContain("sin(dot(");
    for (const stream of ["DROP", "RESPAWN_Y", "STEP_X", "STEP_Y"]) {
      expect(updateFrag).toContain(`draw(${stream})`);
    }
  });

  it("respawns invalid particle state in the update shader", () => {
    expect(updateFrag).toContain("invalidNormalizedPosition");
    expect(updateFrag).toContain("invalidWrappedPosition");
    expect(updateFrag).toContain("drop = 1.0");
  });

  it("supports float particle state with an RGBA8-packed fallback", () => {
    expect(updateFrag).toContain("USE_FLOAT_STATE");
    expect(drawVert).toContain("USE_FLOAT_STATE");
    expect(updateFrag).toContain("vec2 pos = encoded.rg");
    expect(updateFrag).toContain("o_state = vec4(newPos, 0.0, 1.0)");
    expect(updateFrag).toContain("const float MIN_STEP = 1.0 / 65025.0");
    expect(updateFrag).toContain("floor(newPos.x * 255.0) / 255.0");
    expect(drawVert).toContain("encoded.r + encoded.g / 255.0");
  });

  it("respawns particles whose computed update step is non-finite or excessive", () => {
    expect(updateFrag).toContain("maxParticleSegmentPx");
    expect(updateFrag).toContain("bool invalidOffset = offset.x != offset.x");
    expect(updateFrag).toContain("segmentPx > maxParticleSegmentPx(zoomScale)");
    expect(updateFrag).toContain(
      "invalidInputPos || invalidNewPos || invalidOffset",
    );
  });

  it("hides invalid particles before projection in the draw shader", () => {
    expect(drawVert).toContain("invalidNormalizedPosition");
    expect(drawVert).toContain("hideParticle()");
    expect(drawVert).toContain("return;");
  });

  it("uses previous state only to hide jump frames, not as the rendered trail", () => {
    expect(drawVert).toContain("uniform sampler2D u_prev_particles");
    expect(drawVert).toContain("texture2D(u_prev_particles, texCoord)");
    expect(drawVert).toContain("actualTransitionPx > maxSegmentPx");
    expect(drawVert).toContain("vec2 headPos = currPos");
    expect(drawVert).toContain("vec2 tailPos = currPos - offset");
    expect(drawVert).toContain("segmentPx > maxSegmentPx");
    expect(drawVert).toContain(
      "dataValidityAtPosition(headPos) < u_valid_threshold",
    );
    expect(drawVert).toContain(
      "dataValidityAtPosition(tailPos) < u_valid_threshold",
    );
    expect(drawVert).toContain("vec2 pos = mix(tailPos, headPos, a_is_curr)");
  });

  it("uses a strict alpha validity threshold for particle updates and drawing", () => {
    expect(updateFrag).toContain("uniform float u_valid_threshold");
    expect(updateFrag).toContain("step(u_valid_threshold, valid)");
    expect(drawVert).toContain("uniform float u_valid_threshold");
    expect(drawVert).toContain("v_valid < u_valid_threshold");
  });

  it("repeats only global velocity grids in longitude", () => {
    for (const shader of [updateFrag, drawVert]) {
      expect(shader).toContain("mod(lng - u_geo_bounds.x, 360.0) / geoWidth");
      expect(shader).toContain("geoWidth >= 359.0 ? fract(u) : u");
      expect(shader).toContain("step(geoUV.x, 1.0)");
      expect(shader).not.toContain("fract((lng - u_geo_bounds.x) / geoWidth)");
    }
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

  it("uses CPU-normalized scalar values without physical-value arithmetic", () => {
    for (const shader of [gridFrag, gridGlobeFrag]) {
      expect(shader).toContain("t = clamp(sample.r, 0.0, 1.0)");
      expect(shader).not.toContain("float scalarValue");
      expect(shader).not.toContain("float scalarRange");
    }
  });

  it("ships runtime shaders with their includes resolved", () => {
    const shaders = [
      drawVert,
      drawFrag,
      fadeFrag,
      updateFrag,
      gridFrag,
      gridGlobeFrag,
      geoVideoFrag,
      compositeFrag,
    ];
    for (const shader of shaders) {
      expect(shader).not.toContain("#include");
    }
    for (const shader of [drawFrag, gridFrag, gridGlobeFrag, geoVideoFrag]) {
      expect(shader).toContain("vec3 applyVibrance(vec3 c, float v)");
    }
  });

  it("draws the backdrop as a flat color on valid cells only", () => {
    for (const shader of [gridFrag, gridGlobeFrag]) {
      const valid = shader.indexOf("if (sample.a < 0.5)");
      const solid = shader.indexOf("if (u_solid.a > 0.0)");
      expect(valid).toBeGreaterThan(-1);
      expect(solid).toBeGreaterThan(valid);
      expect(shader).toContain("gl_FragColor = u_solid;");
    }
  });

  it("grades the trail composite only when enabled", () => {
    expect(compositeFrag).toContain("vec3 gradeColor(vec3 c, vec4 g)");
    expect(compositeFrag).toContain("vec3 applyVibrance(vec3 c, float v)");
    expect(compositeFrag).toContain(
      "u_grade_on > 0.5 ? gradeColor(color.rgb, u_grade) : color.rgb",
    );
    // Same alpha handling as the fade pass at opacity 1.
    expect(compositeFrag).toContain("step(1.0 / 255.0, alpha)");
  });
});
