#version 300 es
precision mediump float;

// Display of the trail texture: fade.frag.glsl at opacity 1, plus the
// optional glow (glow.glsl) and color grade (color-grade.glsl). Off, colors
// pass unchanged.
uniform sampler2D u_screen;
uniform sampler2D u_glow_tex;
uniform float u_glow;
uniform float u_grade_on;
uniform vec4 u_grade;
in vec2 v_tex_coord;
out vec4 o_color;

#include ./glow.glsl;
#include ./color-grade.glsl;

void main() {
    vec4 color = texture(u_screen, v_tex_coord);
    float alpha = floor(color.a * 255.0) / 255.0;
    color = vec4(color.rgb * step(1.0 / 255.0, alpha), alpha);
    if (u_glow > 0.0) {
        color = addGlow(color, u_glow_tex, v_tex_coord, u_glow);
    }
    vec3 rgb = u_grade_on > 0.5 ? gradeColor(color.rgb, u_grade) : color.rgb;
    o_color = vec4(rgb, color.a);
}
