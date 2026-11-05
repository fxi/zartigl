#version 300 es
precision highp float;

// Solid or dashed lines; `u_dash` is the dash period in world units (0: solid).
in float v_dist;
uniform vec4 u_color;
uniform float u_dash;
out vec4 o_color;

void main() {
    if (u_dash > 0.0 && fract(v_dist / u_dash) > 0.55) {
        discard;
    }
    o_color = vec4(u_color.rgb * u_color.a, u_color.a);
}
