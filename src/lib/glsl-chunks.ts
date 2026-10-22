import colorGradeGlsl from "./shaders/color-grade.glsl";
import randomGlsl from "./shaders/random.glsl";
import vibranceGlsl from "./shaders/vibrance.glsl";

// Shared GLSL chunks as strings, for renderers outside this build (which
// cannot `#include` these files): the same sources the zartigl shaders
// include.

/** `vec3 applyVibrance(vec3 c, float v)`; GLSL ES 1.0 and 3.0. */
export const VIBRANCE_GLSL: string = vibranceGlsl;

/**
 * `vec3 gradeColor(vec3 c, vec4 g)` of `colorGradeVec4`; GLSL ES 1.0 and
 * 3.0. It contains VIBRANCE_GLSL: include one or the other, never both.
 */
export const COLOR_GRADE_GLSL: string = colorGradeGlsl;

/** `float random(uvec3 v)`, an integer hash in [0, 1); GLSL ES 3.0. */
export const RANDOM_GLSL: string = randomGlsl;
