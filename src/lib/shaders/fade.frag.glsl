#version 300 es
precision mediump float;

uniform sampler2D u_screen;
uniform float u_opacity;
in vec2 v_tex_coord;
out vec4 o_color;

void main() {
    vec4 color = texture(u_screen, v_tex_coord);
    // Trails hold straight color: fade alpha only. Scaling rgb too loses one
    // 8-bit code per channel and frame, so trails drift in hue and turn black
    // before alpha reaches 0, leaving dark streaks over the map.
    // Floor trick ensures trails actually disappear on 8-bit framebuffers.
    float alpha = floor(color.a * 255.0 * u_opacity) / 255.0;
    // A cleared texel keeps no color for the next particle to blend with.
    o_color = vec4(color.rgb * step(1.0 / 255.0, alpha), alpha);
}
