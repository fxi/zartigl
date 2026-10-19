import { describe, expect, it } from "vitest";
import advectFrag from "./shaders/advect.frag.glsl";
import compositeFrag from "./shaders/composite.frag.glsl";
import rasterFrag from "./shaders/raster.frag.glsl";
import rasterVert from "./shaders/raster.vert.glsl";

describe("projversor advection randomness", () => {
  it("draws respawns from the integer hash, not from sin", () => {
    expect(advectFrag).toContain("float random(uvec3 v)");
    expect(advectFrag).toContain("uniform uint u_frame");
    expect(advectFrag).not.toContain("sin(dot(");
    expect(advectFrag).not.toContain("u_seed");
  });
});

describe("projversor grids", () => {
  it("samples regional grids only inside their bounds", () => {
    for (const shader of [advectFrag, rasterFrag]) {
      expect(shader).toContain("bool onGrid(vec2 uv, vec4 bounds)");
    }
    expect(advectFrag).toContain("if (!onGrid(uv, u_bounds))");
    expect(rasterFrag).toContain("if (!onGrid(uv, u_tint_bounds))");
  });

  it("applies the catalog vibrance like zartigl's scalar shaders", () => {
    expect(rasterFrag).toContain("vec3 applyVibrance(vec3 c, float v)");
    expect(rasterFrag).toContain("applyVibrance(texture(u_ramp");
  });

  it("grades the trail composite with zartigl's shared helper", () => {
    expect(compositeFrag).not.toContain("#include");
    expect(compositeFrag).toContain("vec3 gradeColor(vec3 c, vec4 g)");
    expect(compositeFrag).toContain(
      "u_grade_on > 0.5 ? gradeColor(color.rgb, u_grade) : color.rgb",
    );
  });

  it("drops raster triangles across a projection cut", () => {
    expect(rasterVert).toContain("longest < u_max_jump");
  });
});
