// Velocity field sampled at a geographic unit vector (d3 cartesian frame).
// Texels: (u east, v north, validity, 0), row 0 at the north edge; the two
// textures are consecutive time steps blended by u_vel_mix.

#include ./grid.glsl;

uniform sampler2D u_vel0;
uniform sampler2D u_vel1;
uniform float u_vel_mix;
uniform vec4 u_bounds;    // west, south, east, north in degrees

/** xy = velocity (m/s), z = validity in [0, 1]. */
vec3 sampleVelocity(vec3 g) {
    vec2 uv = geoUv(g, u_bounds);
    if (!onGrid(uv, u_bounds)) return vec3(0.0);
    return mix(texture(u_vel0, uv).xyz, texture(u_vel1, uv).xyz, u_vel_mix);
}

/**
 * Move `p` by `h` radians along the direction of `vel` (east, north): a
 * tangent step then a renormalization, with no singularity at the poles.
 */
vec3 flowStep(vec3 p, vec2 vel, float h) {
    float r = length(p.xy);
    vec3 east = r > 1e-6 ? vec3(-p.y, p.x, 0.0) / r : vec3(0.0, 1.0, 0.0);
    vec3 north = cross(p, east);
    vec2 dir = vel / max(length(vel), 1e-9);
    return normalize(p + (dir.x * east + dir.y * north) * h);
}
