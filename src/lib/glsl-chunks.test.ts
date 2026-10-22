import { describe, expect, it } from "vitest";
import { COLOR_GRADE_GLSL, RANDOM_GLSL, VIBRANCE_GLSL } from "./glsl-chunks";
import colorGrade from "./shaders/color-grade.glsl";
import random from "./shaders/random.glsl";
import vibrance from "./shaders/vibrance.glsl";

const count = (text: string, part: string) => text.split(part).length - 1;

describe("shared GLSL chunks", () => {
  it("are the sources the zartigl shaders include", () => {
    expect(VIBRANCE_GLSL).toBe(vibrance);
    expect(COLOR_GRADE_GLSL).toBe(colorGrade);
    expect(RANDOM_GLSL).toBe(random);
  });

  it("are self-contained, with vibrance once in the color grade", () => {
    for (const chunk of [VIBRANCE_GLSL, COLOR_GRADE_GLSL, RANDOM_GLSL]) {
      expect(chunk).not.toContain("#include");
    }
    expect(VIBRANCE_GLSL).toContain("vec3 applyVibrance(vec3 c, float v)");
    expect(count(COLOR_GRADE_GLSL, "vec3 applyVibrance(vec3 c")).toBe(1);
    expect(COLOR_GRADE_GLSL).toContain("vec3 gradeColor(vec3 c, vec4 g)");
    expect(RANDOM_GLSL).toContain("float random(uvec3 v)");
  });
});
