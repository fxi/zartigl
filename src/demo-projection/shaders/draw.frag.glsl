#version 300 es
precision highp float;

uniform sampler2D u_ramp;
uniform float u_opacity;

in float v_speed;
out vec4 o_color;

void main() {
    // Square-root ramp position, as the legend (scales.ts rampPosition).
    o_color = vec4(texture(u_ramp, vec2(sqrt(v_speed), 0.5)).rgb, u_opacity);
}
