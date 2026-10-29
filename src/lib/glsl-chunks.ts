import velocityBlendGlsl from "./shaders/velocity-blend.glsl";
import colorGradeGlsl from "./shaders/color-grade.glsl";
import geoVideoScalarGlsl from "./shaders/geovideo-scalar.glsl";
import randomGlsl from "./shaders/random.glsl";
import vibranceGlsl from "./shaders/vibrance.glsl";
import glowGlsl from "./shaders/glow.glsl";

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

/**
 * `float geoVideoScalarValue(float r)`: a scalar-luma frame's red channel to
 * its value, with the `u_code_range` / `u_value_range` uniforms it declares
 * (geoVideoScalarUniforms); GLSL ES 1.0 and 3.0. The one scalar GeoVideo
 * decoder: frames go to the GPU as images, never read back.
 */
export const GEOVIDEO_SCALAR_GLSL: string = geoVideoScalarGlsl;

/** Physical velocity/validity decoding and temporal blending; GLSL ES 1.0 and 3.0. */
export const VELOCITY_BLEND_GLSL: string = velocityBlendGlsl;

/**
 * Particle glow, `vec4 glowGather(sampler2D trails, ivec2 texel)` and
 * `vec4 addGlow(vec4 trail, sampler2D glowTex, vec2 uv, float gain)`; GLSL
 * ES 3.0. Gather the trails into a texture GLOW_SCALE× smaller, then add it
 * under them at GLOW_GAIN × the style's glow.
 */
export const GLOW_GLSL: string = glowGlsl;

/** Trail texels per glow texel along each axis: the chunk's GLOW_SCALE. */
export const GLOW_SCALE = 4;

/**
 * Glow gain at glow = 1. A thin trail covers about a quarter of its glow
 * texel, so this keeps the halo faint even over dense trails.
 */
export const GLOW_GAIN = 1.2;
