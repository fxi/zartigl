#version 300 es
precision highp float;

#include ./project.glsl;
#include ./velocity.glsl;
#include ./tint.glsl;

// One GL_LINES segment per particle, from its previous to its current
// position, as zartigl's draw.vert.glsl. Both ends are projected with the
// current view; trails build up in the screen texture.
uniform sampler2D u_prev;
uniform sampler2D u_curr;
uniform int u_size;         // state texture side
uniform mat3 u_rot;         // geographic -> rotated frame
uniform float u_clip;
uniform float u_max_jump;   // px; longer segments cross a cut
// Tinted: color from the tint field over u_tint_domain, brightness from
// speed. Otherwise color from speed, as zartigl.
uniform bool u_tinted;
uniform vec2 u_tint_domain;

out float v_color;
out float v_bright;

vec2 projectGeo(vec3 g, out float c) {
    vec3 r = u_rot * g;
    c = centerDistance(r);
    vec2 ll = lonLat(r);
    return projectPx(ll.x, ll.y);
}

void main() {
    int particle = gl_VertexID / 2;
    ivec2 texel = ivec2(particle % u_size, particle / u_size);
    vec4 a = texelFetch(u_prev, texel, 0);
    vec4 b = texelFetch(u_curr, texel, 0);

    float ca;
    float cb;
    vec2 pa = projectGeo(a.xyz, ca);
    vec2 pb = projectGeo(b.xyz, cb);
    // Validate the whole segment before picking an end: a single hidden
    // vertex would still rasterize a long line to the visible one.
    bool visible = b.w >= 0.0 &&
        dot(a.xyz, a.xyz) > 0.5 &&
        max(ca, cb) <= u_clip &&
        distance(pa, pb) < u_max_jump &&
        sampleVelocity(b.xyz).z >= 0.5;
    // Square-root ramp position, as the legend (scales.ts rampPosition).
    float speed = sqrt(b.w);
    vec2 tint = u_tinted ? sampleTint(b.xyz) : vec2(0.0);
    if (tint.y >= 0.5) {
        v_color = clamp(
            (tint.x / tint.y - u_tint_domain.x) /
                (u_tint_domain.y - u_tint_domain.x),
            0.0,
            1.0
        );
        v_bright = mix(0.3, 1.0, speed);
    } else {
        v_color = speed;
        v_bright = 1.0;
    }
    gl_Position = visible
        ? pxToClip(gl_VertexID % 2 == 0 ? pa : pb, 0.0)
        : vec4(2.0, 2.0, 2.0, 1.0);
}
