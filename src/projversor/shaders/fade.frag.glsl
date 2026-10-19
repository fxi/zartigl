#version 300 es
precision highp float;

// zartigl's fade.frag.glsl: dim the previous screen; opacity 1 blits it.
uniform sampler2D u_screen;
uniform float u_opacity;

in vec2 v_uv;
out vec4 o_color;

void main() {
    vec4 color = texture(u_screen, v_uv);
    // Trails hold straight color and fade in alpha only, so they keep their
    // hue and never turn black before vanishing. The floor trick ensures
    // trails actually disappear on 8-bit framebuffers.
    float alpha = floor(color.a * 255.0 * u_opacity) / 255.0;
    o_color = vec4(color.rgb * step(1.0 / 255.0, alpha), alpha);
}
