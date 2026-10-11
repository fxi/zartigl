#version 300 es
precision highp float;

#include ./velocity.glsl;

// Particles live on the unit sphere (geographic cartesian frame). Motion and
// respawn follow zartigl's update.frag.glsl: linear visual speed, a random
// drop rate bumped by the local speed, respawn uniform in the visible cap.
uniform sampler2D u_state;  // xyz, w = speed fraction, -1 on a respawn
uniform mat3 u_rot_inv;     // rotated frame -> geographic
uniform float u_step;       // radians per frame at u_max_speed
uniform float u_max_speed;
uniform float u_keep_cos;   // particles farther than this cap respawn
uniform float u_drop;       // per-frame respawn probability
uniform float u_drop_bump;  // added per m/s
uniform float u_seed;
uniform float u_reset;

in vec2 v_uv;
out vec4 o_state;

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
    vec3 p = texture(u_state, v_uv).xyz;
    vec2 seed = v_uv * 91.7 + vec2(u_seed, u_seed * 0.37);
    // u_rot_inv[0] is the projection center in geographic coordinates.
    bool respawn = u_reset > 0.5 || dot(p, p) < 0.5 ||
        dot(u_rot_inv[0], p) < u_keep_cos;
    float speed = 0.0;
    if (!respawn) {
        vec3 vel = sampleVelocity(p);
        float v = length(vel.xy);
        if (vel.z < 0.5 || rand(seed) < u_drop + v * u_drop_bump) {
            respawn = true;
        } else {
            speed = min(v / u_max_speed, 1.0);
            p = flowStep(p, vel.xy, speed * u_step);
        }
    }
    if (respawn) {
        // A negative speed hides the jump from the old position.
        o_state = vec4(spawn(seed + vec2(3.7, 1.9)), -1.0);
        return;
    }
    o_state = vec4(p, speed);
}
