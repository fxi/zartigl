precision mediump float;

uniform sampler2D u_field;        // velocity texture: R=u_norm, G=v_norm, A=validity
uniform sampler2D u_color_ramp;   // 256x1 color gradient
uniform float u_field_min;        // minimum speed for normalization
uniform float u_field_max;        // maximum speed for normalization
uniform float u_u_min;            // u component physical min (m/s)
uniform float u_u_max;            // u component physical max (m/s)
uniform float u_v_min;            // v component physical min (m/s)
uniform float u_v_max;            // v component physical max (m/s)
uniform float u_opacity;          // overall opacity of raster layer
uniform float u_log_scale;        // 0.0 = linear, 1.0 = log normalization
uniform float u_vibrance;         // vibrance adjustment [-1, 1]
uniform float u_scalar_mode;      // 0.0 = vector (speed magnitude), 1.0 = scalar (R direct)

varying vec2 v_geo_uv;            // field texture UV [0,1]

vec3 applyVibrance(vec3 c, float v) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    float boost = v * (1.0 - sat);
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    return mix(vec3(luma), c, 1.0 + boost);
}

void main() {
    if (v_geo_uv.x < 0.0 || v_geo_uv.x > 1.0 || v_geo_uv.y < 0.0 || v_geo_uv.y > 1.0) {
        discard;
    }

    vec4 sample = texture2D(u_field, v_geo_uv);

    // validity mask (alpha channel)
    if (sample.a < 0.5) {
        discard;
    }

    float t;
    if (u_scalar_mode > 0.5) {
        // Scalar: R channel is already normalized [0,1] — use directly
        t = clamp(sample.r, 0.0, 1.0);
    } else {
        // Vector: decode physical values, compute speed magnitude
        float u = mix(u_u_min, u_u_max, sample.r);
        float v = mix(u_v_min, u_v_max, sample.g);
        float speed = length(vec2(u, v));
        t = clamp((speed - u_field_min) / (u_field_max - u_field_min), 0.0, 1.0);
    }

    // optional log scale
    t = mix(t, log(1.0 + t * 9.0) / log(10.0), u_log_scale);

    vec4 color = texture2D(u_color_ramp, vec2(t, 0.5));
    color.rgb = applyVibrance(color.rgb, u_vibrance);
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
}
