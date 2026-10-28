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
uniform vec4 u_solid;             // alpha > 0: flat backdrop color instead of the ramp

varying vec2 v_geo_uv;            // field texture UV [0,1]

#include ./vibrance.glsl;

#include ./velocity-pair.glsl;

void main() {
    if (v_geo_uv.x < 0.0 || v_geo_uv.x > 1.0 || v_geo_uv.y < 0.0 || v_geo_uv.y > 1.0) {
        discard;
    }

    vec4 sample = texture2D(u_field, v_geo_uv);
    if (u_scalar_mode < 0.5) {
        vec3 velocity = sampleVelocityPair(u_field, v_geo_uv, vec2(u_u_min, u_v_min), vec2(u_u_max, u_v_max));
        sample = vec4(velocity.xy, 0.0, velocity.z);
    }

    // validity mask (alpha channel)
    if (sample.a < 0.5) {
        discard;
    }
    if (u_solid.a > 0.0) {
        gl_FragColor = u_solid;
        return;
    }

    float t;
    if (u_scalar_mode > 0.5) {
        // Scalar textures are normalized on the CPU against either the fixed
        // color domain or the current frame extrema.
        t = clamp(sample.r, 0.0, 1.0);
    } else {
        // Vector: decode physical values, compute speed magnitude
        float speed = length(sample.rg);
        t = clamp((speed - u_field_min) / (u_field_max - u_field_min), 0.0, 1.0);
    }

    // optional log scale
    t = mix(t, log(1.0 + t * 9.0) / log(10.0), u_log_scale);

    vec4 color = texture2D(u_color_ramp, vec2(t, 0.5));
    color.rgb = applyVibrance(color.rgb, u_vibrance);
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
}
