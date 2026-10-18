#version 300 es
precision mediump float;

// Display of the trail texture: fade.frag.glsl at opacity 1, plus the
// optional color grade (color-grade.glsl). Off, colors pass unchanged.
uniform sampler2D u_screen;
uniform float u_grade_on;
uniform vec4 u_grade;
in vec2 v_tex_coord;
out vec4 o_color;

#include ./color-grade.glsl;

void main() {
    vec4 color = texture(u_screen, v_tex_coord);
    float alpha = floor(color.a * 255.0) / 255.0;
    vec3 rgb = u_grade_on > 0.5 ? gradeColor(color.rgb, u_grade) : color.rgb;
    o_color = vec4(rgb * step(1.0 / 255.0, alpha), alpha);
}
