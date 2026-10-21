import { describe, expect, it } from "vitest";
import {
  COLOR_GRADE_OFF,
  COLOR_GRADE_VIBRANT,
  colorGradeToGrade,
  colorGradeVec4,
  gradeToColorGrade,
  resolveColorGrade,
} from "./color-grade";

describe("color grade", () => {
  it("is off without input", () => {
    expect(resolveColorGrade()).toEqual(COLOR_GRADE_OFF);
    expect(resolveColorGrade().enabled).toBe(false);
  });

  it("means the vibrant preset for empty input", () => {
    expect(resolveColorGrade({})).toEqual(COLOR_GRADE_VIBRANT);
  });

  it("merges partial input over the preset and keeps an explicit off", () => {
    expect(resolveColorGrade({ contrast: 0.2 })).toEqual({
      ...COLOR_GRADE_VIBRANT,
      contrast: 0.2,
    });
    expect(resolveColorGrade({ enabled: false }).enabled).toBe(false);
  });

  it("clamps out-of-range values and ignores non-finite ones", () => {
    expect(
      resolveColorGrade({
        exposure: 9,
        contrast: -1,
        saturation: -3,
        highlights: Number.NaN,
      }),
    ).toEqual({
      enabled: true,
      exposure: 4,
      contrast: 0,
      saturation: -1,
      highlights: COLOR_GRADE_VIBRANT.highlights,
    });
  });

  it("packs the shader uniform in GLSL order", () => {
    expect(
      colorGradeVec4({
        enabled: true,
        exposure: 1,
        contrast: 2,
        saturation: 3,
        highlights: 4,
      }),
    ).toEqual([1, 2, 3, 4]);
  });
});

describe("style grade", () => {
  it("maps presets and tuned grades both ways", () => {
    expect(gradeToColorGrade(undefined)).toEqual(COLOR_GRADE_OFF);
    expect(gradeToColorGrade("off")).toEqual(COLOR_GRADE_OFF);
    expect(gradeToColorGrade("vibrant")).toEqual(COLOR_GRADE_VIBRANT);
    expect(gradeToColorGrade({ contrast: 0.2 })).toEqual({
      ...COLOR_GRADE_VIBRANT,
      contrast: 0.2,
    });
    expect(colorGradeToGrade(COLOR_GRADE_OFF)).toBe("off");
    expect(colorGradeToGrade({})).toBe("vibrant");
    expect(colorGradeToGrade({ contrast: 0.2 })).toEqual({
      exposure: COLOR_GRADE_VIBRANT.exposure,
      contrast: 0.2,
      saturation: COLOR_GRADE_VIBRANT.saturation,
      highlights: COLOR_GRADE_VIBRANT.highlights,
    });
  });
});
