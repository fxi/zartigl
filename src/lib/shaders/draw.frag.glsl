precision mediump float;

uniform sampler2D u_color_ramp;
varying float v_speed;
varying float v_valid;

void main() {
    if (v_valid < 0.5) discard;
    gl_FragColor = texture2D(u_color_ramp, vec2(v_speed, 0.5));
}
