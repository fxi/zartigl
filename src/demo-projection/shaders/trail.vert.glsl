#version 300 es
precision highp float;
precision highp sampler2DArray;

#include ./project.glsl;

// One GL_LINES segment per (particle, history step), from gl_VertexID. The
// trail is stored on the sphere, so it reprojects with the view.
uniform sampler2DArray u_history;
uniform int u_head;         // slot written by the last advection
uniform int u_slots;
uniform int u_segments;     // drawn per particle, at most u_slots - 1
uniform int u_size;         // state texture side
uniform mat3 u_rot;         // geographic -> rotated frame
uniform float u_clip;
uniform float u_max_jump;   // px; longer segments cross a cut

out float v_alpha;
out float v_speed;

vec2 projectGeo(vec3 g, out float c) {
    vec3 r = u_rot * g;
    c = centerDistance(r);
    vec2 ll = lonLat(r);
    return projectPx(ll.x, ll.y);
}

void main() {
    int segments = u_segments;
    int end = gl_VertexID % 2;
    int segment = (gl_VertexID / 2) % segments;
    int particle = gl_VertexID / (2 * segments);
    int newer = (u_head - segment + u_slots) % u_slots;
    int older = (newer - 1 + u_slots) % u_slots;
    ivec2 texel = ivec2(particle % u_size, particle / u_size);
    vec4 a = texelFetch(u_history, ivec3(texel, older), 0);
    vec4 b = texelFetch(u_history, ivec3(texel, newer), 0);

    float ca;
    float cb;
    vec2 pa = projectGeo(a.xyz, ca);
    vec2 pb = projectGeo(b.xyz, cb);
    // One advection apart, otherwise the particle respawned in between.
    bool continuous = abs(floor(b.w) - floor(a.w) - 1.0) < 0.5;
    bool visible = continuous &&
        max(ca, cb) <= u_clip &&
        distance(pa, pb) < u_max_jump;

    float trail = 1.0 - (float(segment) + float(1 - end)) / float(segments);
    float fadeIn = clamp(floor(b.w) / 8.0, 0.0, 1.0);
    v_alpha = visible ? trail * fadeIn : 0.0;
    v_speed = fract(b.w);
    gl_Position = visible ? pxToClip(end == 0 ? pa : pb, 0.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
