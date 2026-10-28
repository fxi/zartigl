#include ./velocity-blend.glsl;

uniform sampler2D u_velocity_next;
uniform vec2 u_velocity_next_min;
uniform vec2 u_velocity_next_max;
uniform float u_velocity_mix;
uniform float u_velocity_physical;
uniform float u_velocity_next_physical;
uniform float u_velocity_flip_y;
uniform float u_velocity_next_flip_y;

vec4 velocityTexel(sampler2D field, vec2 uv, float flipY) {
    uv.y = mix(uv.y, 1.0 - uv.y, flipY);
#if __VERSION__ >= 300
    return texture(field, uv);
#else
    return texture2D(field, uv);
#endif
}

vec3 sampleVelocityPair(sampler2D field, vec2 uv, vec2 minimum, vec2 maximum) {
    vec3 a = velocityValue(velocityTexel(field, uv, u_velocity_flip_y), minimum, maximum, u_velocity_physical);
    // The single-field Zarr path retains its original sample and decoding.
    if (u_velocity_mix <= 0.0) return a;
    vec3 b = velocityValue(velocityTexel(u_velocity_next, uv, u_velocity_next_flip_y), u_velocity_next_min, u_velocity_next_max, u_velocity_next_physical);
    return blendVelocity(a, b, u_velocity_mix);
}
