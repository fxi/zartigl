precision mediump float;

uniform sampler2D u_color;
uniform sampler2D u_mask;
uniform float u_opacity;
uniform vec2 u_texel_size;

varying vec2 v_geo_uv;

void main() {
    vec2 sourceUv = vec2(v_geo_uv.x, 1.0 - v_geo_uv.y);
    vec2 halfTexel = 0.5 * u_texel_size;
    vec2 uv = mix(halfTexel, vec2(1.0) - halfTexel, sourceUv);
    vec3 color = texture2D(u_color, uv).rgb;
    float alpha = texture2D(u_mask, uv).r;
    if (alpha <= 0.003) discard;
    gl_FragColor = vec4(color, alpha * u_opacity);
}
