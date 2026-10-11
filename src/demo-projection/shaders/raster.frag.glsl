#version 300 es
precision highp float;

#include ./velocity.glsl;

uniform mat3 u_rot_inv;     // rotated frame -> geographic
uniform float u_clip;       // radians; >= PI disables the circle clip
uniform sampler2D u_ramp;
uniform float u_max_speed;  // m/s at the top of the ramp
uniform float u_brightness;

in vec3 v_rot;
out vec4 o_color;

void main() {
    vec3 r = normalize(v_rot);
    if (acos(clamp(r.x, -1.0, 1.0)) > u_clip) discard;
    vec3 vel = sampleVelocity(u_rot_inv * r);
    if (vel.z < 0.5) discard;
    float t = sqrt(clamp(length(vel.xy) / u_max_speed, 0.0, 1.0));
    o_color = vec4(texture(u_ramp, vec2(t, 0.5)).rgb * u_brightness, 1.0);
}
