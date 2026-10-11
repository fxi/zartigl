// Velocity field sampled at a geographic unit vector (d3 cartesian frame).
// Texels: (u east, v north, validity, 0), row 0 at the north edge; the two
// textures are consecutive time steps blended by u_vel_mix.

uniform sampler2D u_vel0;
uniform sampler2D u_vel1;
uniform float u_vel_mix;
uniform vec4 u_bounds;    // west, south, east, north in degrees

vec2 geoUv(vec3 g) {
    float lon = degrees(atan(g.y, g.x));
    float lat = degrees(asin(clamp(g.z, -1.0, 1.0)));
    return vec2(
        (lon - u_bounds.x) / (u_bounds.z - u_bounds.x),
        (u_bounds.w - lat) / (u_bounds.w - u_bounds.y)
    );
}

/** xy = velocity (m/s), z = validity in [0, 1]. */
vec3 sampleVelocity(vec3 g) {
    vec2 uv = geoUv(g);
    if (uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
    return mix(texture(u_vel0, uv).xyz, texture(u_vel1, uv).xyz, u_vel_mix);
}
