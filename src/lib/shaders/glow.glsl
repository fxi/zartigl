// Particle glow: a halo of the trails' own color, as small LEDs lighting
// their surroundings. GLSL ES 3.0.
//
// glowGather: one texel of the glow texture, GLOW_SCALE× smaller than the
// trails: the box of trail texels it covers, premultiplied, so cleared
// texels (rgb 0) do not darken the halo.
// addGlow: straight trail color over the glow (premultiplied, upsampled
// with a tent of four bilinear taps), back to straight color.

#define GLOW_SCALE 4

vec4 glowGather(sampler2D trails, ivec2 texel) {
    ivec2 last = textureSize(trails, 0) - 1;
    ivec2 origin = texel * GLOW_SCALE;
    vec4 sum = vec4(0.0);
    for (int y = 0; y < GLOW_SCALE; y++) {
        for (int x = 0; x < GLOW_SCALE; x++) {
            vec4 c = texelFetch(trails, min(origin + ivec2(x, y), last), 0);
            sum += vec4(c.rgb * c.a, c.a);
        }
    }
    return sum / float(GLOW_SCALE * GLOW_SCALE);
}

vec4 addGlow(vec4 trail, sampler2D glowTex, vec2 uv, float gain) {
    vec2 d = 1.0 / vec2(textureSize(glowTex, 0));
    vec4 glow = 0.25 * (
        texture(glowTex, uv + vec2(-d.x, -d.y)) +
        texture(glowTex, uv + vec2(d.x, -d.y)) +
        texture(glowTex, uv + vec2(-d.x, d.y)) +
        texture(glowTex, uv + vec2(d.x, d.y)));
    glow = min(glow * gain, vec4(1.0));
    float under = 1.0 - trail.a;
    float alpha = trail.a + glow.a * under;
    vec3 rgb = (trail.rgb * trail.a + glow.rgb * under) / max(alpha, 1e-4);
    return vec4(rgb, alpha);
}
