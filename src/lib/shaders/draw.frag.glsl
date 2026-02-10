precision mediump float;

uniform sampler2D u_color_ramp;
varying float v_speed;

void main() {
    gl_FragColor = texture2D(u_color_ramp, vec2(v_speed, 0.5));
}
