precision mediump float;

uniform sampler2D u_field;
uniform sampler2D u_color_ramp;
uniform float u_field_min;
uniform float u_field_max;
uniform float u_u_min;
uniform float u_u_max;
uniform float u_v_min;
uniform float u_v_max;
uniform float u_opacity;
uniform float u_log_scale;
uniform float u_vibrance;
uniform float u_scalar_mode;

varying vec2 v_geo_uv;

vec3 applyVibrance(vec3 c, float v) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    float boost = v * (1.0 - sat);
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    return mix(vec3(luma), c, 1.0 + boost);
}

void main() {
    vec4 sample = texture2D(u_field, v_geo_uv);
    if (sample.a < 0.5) {
        discard;
    }

    float t;
    if (u_scalar_mode > 0.5) {
        t = clamp(sample.r, 0.0, 1.0);
    } else {
        float u = mix(u_u_min, u_u_max, sample.r);
        float v = mix(u_v_min, u_v_max, sample.g);
        float speed = length(vec2(u, v));
        t = clamp((speed - u_field_min) / (u_field_max - u_field_min), 0.0, 1.0);
    }

    t = mix(t, log(1.0 + t * 9.0) / log(10.0), u_log_scale);

    vec4 color = texture2D(u_color_ramp, vec2(t, 0.5));
    color.rgb = applyVibrance(color.rgb, u_vibrance);
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
}
