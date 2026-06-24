precision mediump float;

uniform sampler2D u_color_ramp;
uniform float u_particle_contrast; // 1.0: select black/white against the raster
uniform float u_opacity;
uniform float u_log_scale;
uniform float u_vibrance;
varying float v_speed;
varying float v_valid;

vec3 applyVibrance(vec3 c, float v) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    float boost = v * (1.0 - sat);
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    return mix(vec3(luma), c, 1.0 + boost);
}

float relativeLuminance(vec3 color) {
    vec3 c = clamp(color, 0.0, 1.0);
    vec3 low = c / 12.92;
    vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
    vec3 linear = mix(high, low, step(c, vec3(0.04045)));
    return dot(linear, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    if (v_valid < 0.5) discard;
    float t = mix(v_speed, log(1.0 + v_speed * 9.0) / log(10.0), u_log_scale);
    vec4 color = texture2D(u_color_ramp, vec2(t, 0.5));
    color.rgb = applyVibrance(color.rgb, u_vibrance);

    if (u_particle_contrast > 0.5) {
        // At this crossover black and white have equal WCAG contrast ratios.
        float useBlack = step(0.179, relativeLuminance(color.rgb));
        color.rgb = mix(vec3(1.0), vec3(0.0), useBlack);
    }
    gl_FragColor = vec4(color.rgb, u_opacity);
}
