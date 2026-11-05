#version 300 es
precision highp float;

// The cube's front faces; each fragment starts a ray into the volume.
in vec3 a_pos;
uniform mat4 u_vp;
uniform vec3 u_half;
out vec3 v_world;

void main() {
    v_world = a_pos * u_half;
    gl_Position = u_vp * vec4(v_world, 1.0);
}
