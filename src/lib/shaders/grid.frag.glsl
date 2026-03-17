precision mediump float;

uniform sampler2D u_field;        // velocity texture: R=u_norm, G=v_norm, A=validity
uniform sampler2D u_color_ramp;   // 256x1 color gradient
uniform vec4 u_bounds;            // screen mercator bounds: [west, south, east, north] (radians)
uniform vec4 u_geo_bounds;        // field geographic bounds: [west, south, east, north] (degrees)
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

varying vec2 v_tex_coord;         // screen UV [0,1]

const float PI = 3.14159265358979323846;
const float DEG = 180.0 / PI;

float mercToLat(float y) {
    return DEG * (2.0 * atan(exp(y)) - PI / 2.0);
}

vec3 applyVibrance(vec3 c, float v) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    float boost = v * (1.0 - sat);
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    return mix(vec3(luma), c, 1.0 + boost);
}

void main() {
    // screen UV -> mercator position
    vec2 mercPos = mix(u_bounds.xy, u_bounds.zw, v_tex_coord);

    // mercator -> geographic degrees
    float lng = mercPos.x * DEG;
    float lat = mercToLat(mercPos.y);

    // geographic -> field texture UV
    vec2 geoUV = (vec2(lng, lat) - u_geo_bounds.xy) / (u_geo_bounds.zw - u_geo_bounds.xy);

    // clamp to valid field region
    if (geoUV.x < 0.0 || geoUV.x > 1.0 || geoUV.y < 0.0 || geoUV.y > 1.0) {
        discard;
    }

    vec4 sample = texture2D(u_field, geoUV);

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
