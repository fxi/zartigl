precision mediump float;

uniform sampler2D u_screen;
uniform float u_opacity;
varying vec2 v_tex_coord;

void main() {
    vec4 color = texture2D(u_screen, v_tex_coord);
    // Floor trick ensures trails actually disappear on 8-bit framebuffers.
    // Fade alpha too so background stays transparent for map compositing.
    gl_FragColor = vec4(
        floor(color.rgb * 255.0 * u_opacity) / 255.0,
        floor(color.a * 255.0 * u_opacity) / 255.0
    );
}
