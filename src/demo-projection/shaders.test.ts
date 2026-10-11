import { describe, expect, it } from "vitest";
import advectFrag from "./shaders/advect.frag.glsl";

describe("projversor advection randomness", () => {
  it("draws respawns from the integer hash, not from sin", () => {
    expect(advectFrag).toContain("float random(uvec3 v)");
    expect(advectFrag).toContain("uniform uint u_frame");
    expect(advectFrag).not.toContain("sin(dot(");
    expect(advectFrag).not.toContain("u_seed");
  });
});
