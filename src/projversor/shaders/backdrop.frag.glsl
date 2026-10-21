#version 300 es
precision highp float;

#include ./velocity.glsl;

// Particle backdrop: a flat color on the valid cells of the velocity field.
uniform vec4 u_solid;
uniform float u_clip;

in vec3 v_geo;
in vec3 v_rot;
out vec4 o_color;

void main() {
    if (acos(clamp(normalize(v_rot).x, -1.0, 1.0)) > u_clip) {
        discard;
    }
    if (sampleVelocity(normalize(v_geo)).z < 0.5) {
        discard;
    }
    o_color = u_solid;
}
