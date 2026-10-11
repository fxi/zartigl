#version 300 es
precision highp float;

#include ./project.glsl;

// Mesh vertex in the rotated frame: its edges are the projection's own cut.
in vec2 a_lonlat;

out vec3 v_rot;

void main() {
    float cp = cos(a_lonlat.y);
    v_rot = vec3(cp * cos(a_lonlat.x), cp * sin(a_lonlat.x), sin(a_lonlat.y));
    // Depth = distance from the center: cells stretched around the antipode
    // and folds of a blended hemisphere projection lose against the front.
    float depth = centerDistance(v_rot) / PI * 2.0 - 1.0;
    gl_Position = pxToClip(projectPx(a_lonlat.x, a_lonlat.y), depth);
}
