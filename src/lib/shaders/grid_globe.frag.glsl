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
uniform vec4 u_solid; // alpha > 0: flat backdrop color instead of the ramp

varying vec2 v_geo_uv;

#include ./vibrance.glsl;

#include ./velocity-pair.glsl;

void main() {
    vec4 sample = texture2D(u_field, v_geo_uv);
    if (u_scalar_mode < 0.5) {
        vec3 velocity = sampleVelocityPair(u_field, v_geo_uv, vec2(u_u_min, u_v_min), vec2(u_u_max, u_v_max));
        sample = vec4(velocity.xy, 0.0, velocity.z);
    }
    if (sample.a < 0.5) {
        discard;
    }
    if (u_solid.a > 0.0) {
        gl_FragColor = u_solid;
        return;
    }

    float t;
    if (u_scalar_mode > 0.5) {
        t = clamp(sample.r, 0.0, 1.0);
    } else {
        float speed = length(sample.rg);
        t = clamp((speed - u_field_min) / (u_field_max - u_field_min), 0.0, 1.0);
    }

    t = mix(t, log(1.0 + t * 9.0) / log(10.0), u_log_scale);

    vec4 color = texture2D(u_color_ramp, vec2(t, 0.5));
    color.rgb = applyVibrance(color.rgb, u_vibrance);
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
}
