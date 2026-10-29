#version 300 es
precision mediump float;

// Glow pass: the trails reduced to the glow texture (glow.glsl).
uniform sampler2D u_screen;
out vec4 o_color;

#include ./glow.glsl;

void main() {
    o_color = glowGather(u_screen, ivec2(gl_FragCoord.xy));
}
