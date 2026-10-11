#version 300 es
precision highp float;

#include ./velocity.glsl;

// Particles live on the unit sphere (geographic cartesian frame): advection
// is a tangent step then a renormalization, with no singularity at the poles.
uniform sampler2D u_state;  // xyz, w = age + speed fraction
uniform mat3 u_rot_inv;     // rotated frame -> geographic
uniform float u_step;       // radians per frame at u_max_speed
uniform float u_max_speed;
uniform float u_keep_cos;   // particles farther than this cap respawn
uniform float u_drop;       // per-frame respawn probability
uniform float u_seed;
uniform float u_reset;

in vec2 v_uv;
layout(location = 0) out vec4 o_state;
layout(location = 1) out vec4 o_history;

const float TAU = 6.283185307179586;

float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

/** Uniform by area in the visible cap around the projection center. */
vec3 spawn(vec2 seed) {
    float cosc = mix(1.0, u_keep_cos, rand(seed));
    float sinc = sqrt(max(0.0, 1.0 - cosc * cosc));
    float az = TAU * rand(seed + vec2(1.31, 7.17));
    return u_rot_inv * vec3(cosc, sinc * cos(az), sinc * sin(az));
}

void main() {
    vec4 s = texture(u_state, v_uv);
    vec3 p = s.xyz;
    float age = floor(s.w);
    vec2 seed = v_uv * 91.7 + vec2(u_seed, u_seed * 0.37);
    bool respawn = u_reset > 0.5 || dot(p, p) < 0.5 || rand(seed) < u_drop;
    float speed = 0.0;

    if (!respawn) {
        vec3 vel = sampleVelocity(p);
        // u_rot_inv[0] is the projection center in geographic coordinates.
        if (vel.z < 0.5 || dot(u_rot_inv[0], p) < u_keep_cos) {
            respawn = true;
        } else {
            float h = length(p.xy);
            vec3 east = h > 1e-6 ? vec3(-p.y, p.x, 0.0) / h : vec3(0.0, 1.0, 0.0);
            vec3 north = cross(p, east);
            // Square-root visual speed keeps slow flow legible next to jets.
            float s = length(vel.xy) / u_max_speed;
            vec2 dir = vel.xy / max(length(vel.xy), 1e-9);
            p = normalize(p + (dir.x * east + dir.y * north) * sqrt(min(s, 1.0)) * u_step);
            age = mod(age + 1.0, 8192.0);
            speed = clamp(s, 0.0, 0.999);
        }
    }
    if (respawn) {
        p = spawn(seed + vec2(3.7, 1.9));
        age = 0.0;
    }
    o_state = vec4(p, age + speed);
    o_history = o_state;
}
