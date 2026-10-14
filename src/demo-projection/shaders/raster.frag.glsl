#version 300 es
precision highp float;

#include ./grid.glsl;
#include ./tint.glsl;

// Scalar field (TINT_UNIFORMS) colored over u_domain, linear, as the legend.
uniform sampler2D u_ramp;
uniform vec2 u_domain;
uniform float u_opacity;
uniform float u_clip;

in vec3 v_geo;
in vec3 v_rot;
out vec4 o_color;

void main() {
    if (acos(clamp(normalize(v_rot).x, -1.0, 1.0)) > u_clip) {
        discard;
    }
    vec2 s = sampleTint(normalize(v_geo));
    if (s.y < 0.5) {
        discard;
    }
    float t = clamp((s.x / s.y - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
    o_color = vec4(texture(u_ramp, vec2(t, 0.5)).rgb, u_opacity);
}
