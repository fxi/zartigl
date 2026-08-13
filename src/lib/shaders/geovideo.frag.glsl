precision mediump float;

uniform sampler2D u_color;
uniform sampler2D u_mask;
uniform sampler2D u_color_ramp;
uniform float u_opacity;
uniform float u_scalar_luma;
uniform float u_log_scale;
uniform float u_vibrance;
uniform float u_mask_threshold;
uniform vec2 u_code_range;
uniform vec2 u_value_range;
uniform vec2 u_color_domain;
uniform vec2 u_texel_size;

varying vec2 v_geo_uv;

vec3 applyVibrance(vec3 c, float v) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float boost = v * (1.0 - (mx - mn));
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    return mix(vec3(luma), c, 1.0 + boost);
}

void main() {
    vec2 sourceUv = vec2(v_geo_uv.x, 1.0 - v_geo_uv.y);
    vec2 halfTexel = 0.5 * u_texel_size;
    vec2 uv = mix(halfTexel, vec2(1.0) - halfTexel, sourceUv);
    vec3 media = texture2D(u_color, uv).rgb;
    float alpha = texture2D(u_mask, uv).r;
    if (alpha <= u_mask_threshold) discard;
    vec3 color = media;
    if (u_scalar_luma > 0.5) {
        float code = clamp((media.r - u_code_range.x) / (u_code_range.y - u_code_range.x), 0.0, 1.0);
        float value = mix(u_value_range.x, u_value_range.y, code);
        float t = clamp((value - u_color_domain.x) / (u_color_domain.y - u_color_domain.x), 0.0, 1.0);
        t = mix(t, log(1.0 + t * 9.0) / log(10.0), u_log_scale);
        color = texture2D(u_color_ramp, vec2(t, 0.5)).rgb;
        color = applyVibrance(color, u_vibrance);
    }
    gl_FragColor = vec4(color, alpha * u_opacity);
}
