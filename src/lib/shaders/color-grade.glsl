// Color grade of the particle composite (color-grade.ts), valid in GLSL ES
// 1.0 and 3.0. g = (exposure, contrast, saturation, highlights). Every step
// maps [0, 1] to [0, 1], so bright tones roll off instead of clipping.

#include ./vibrance.glsl;

vec3 gradeColor(vec3 c, vec4 g) {
    float m = max(c.r, max(c.g, c.b));
    if (m > 0.0) {
        // Exposure: normalized exponential curve on the brightest channel,
        // applied as a common factor so hues hold; 0 and 1 stay fixed.
        float e = g.x > 1e-3 ? (1.0 - exp(-g.x * m)) / (1.0 - exp(-g.x)) : m;
        // Highlights: push the bright half toward 1, never past it.
        e += g.w * smoothstep(0.5, 1.0, e) * (1.0 - e);
        c *= e / m;
    }
    // Contrast: S-curve, deeper shadows and brighter highlights.
    c = mix(c, c * c * (3.0 - 2.0 * c), g.y);
    return clamp(applyVibrance(c, g.z), 0.0, 1.0);
}
