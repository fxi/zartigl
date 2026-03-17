precision mediump float;

uniform sampler2D u_color_ramp;
uniform vec4 u_particle_color; // if .a > 0.5: use this RGB; otherwise use speed colormap
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

void main() {
    if (v_valid < 0.5) discard;
    if (u_particle_color.a > 0.5) {
        gl_FragColor = vec4(u_particle_color.rgb, u_opacity);
    } else {
        float t = mix(v_speed, log(1.0 + v_speed * 9.0) / log(10.0), u_log_scale);
        vec4 color = texture2D(u_color_ramp, vec2(t, 0.5));
        color.rgb = applyVibrance(color.rgb, u_vibrance);
        gl_FragColor = vec4(color.rgb, u_opacity);
    }
}
