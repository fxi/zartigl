// Scalar field (e.g. temperature) that tints the particles, sampled like
// velocity.glsl (include it first, for grid.glsl). Texels: (value,
// validity); the two textures are consecutive time steps blended by u_tint_mix.

uniform sampler2D u_tint0;
uniform sampler2D u_tint1;
uniform float u_tint_mix;
uniform vec4 u_tint_bounds;  // west, south, east, north in degrees

/** x = value, y = validity in [0, 1]. */
vec2 sampleTint(vec3 g) {
    vec2 uv = geoUv(g, u_tint_bounds);
    if (!onGrid(uv, u_tint_bounds)) return vec2(0.0);
    return mix(texture(u_tint0, uv).xy, texture(u_tint1, uv).xy, u_tint_mix);
}
