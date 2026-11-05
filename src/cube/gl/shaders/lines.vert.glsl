#version 300 es
precision highp float;

in vec3 a_pos;
in float a_dist;
uniform mat4 u_vp;
out float v_dist;

void main() {
    v_dist = a_dist;
    gl_Position = u_vp * vec4(a_pos, 1.0);
}
