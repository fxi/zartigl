#version 300 es
precision highp float;

uniform sampler2D u_ramp;
uniform float u_opacity;

in float v_alpha;
in float v_speed;
out vec4 o_color;

void main() {
    vec3 color = texture(u_ramp, vec2(sqrt(v_speed), 0.5)).rgb;
    // Lift toward white: trails read as light over the darker raster.
    o_color = vec4(mix(color, vec3(1.0), 0.12), v_alpha * u_opacity);
}
