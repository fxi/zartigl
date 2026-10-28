// Physical east/north velocity and validity, independent of texture layout.
vec3 velocityValue(vec4 texel, vec2 minimum, vec2 maximum, float physical) {
    if (physical > 0.5) return texel.xyz;
    return vec3(mix(minimum, maximum, texel.rg), texel.a);
}

vec3 blendVelocity(vec3 a, vec3 b, float fraction) {
    if (fraction <= 0.0) return a;
    return mix(a, b, fraction);
}
