precision mediump float;

uniform sampler2D u_screen;
uniform vec2 u_pixel_size;   // vec2(1.0/width, 1.0/height)
uniform float u_blur_radius; // 0..5 pixels
uniform vec2 u_direction;    // vec2(1,0) or vec2(0,1)
varying vec2 v_tex_coord;

void main() {
  vec2 step = u_direction * u_pixel_size * u_blur_radius / 4.0;
  vec4 color = vec4(0.0);
  color += texture2D(u_screen, v_tex_coord - step * 4.0) * 0.028;
  color += texture2D(u_screen, v_tex_coord - step * 3.0) * 0.066;
  color += texture2D(u_screen, v_tex_coord - step * 2.0) * 0.124;
  color += texture2D(u_screen, v_tex_coord - step * 1.0) * 0.180;
  color += texture2D(u_screen, v_tex_coord             ) * 0.204;
  color += texture2D(u_screen, v_tex_coord + step * 1.0) * 0.180;
  color += texture2D(u_screen, v_tex_coord + step * 2.0) * 0.124;
  color += texture2D(u_screen, v_tex_coord + step * 3.0) * 0.066;
  color += texture2D(u_screen, v_tex_coord + step * 4.0) * 0.028;
  gl_FragColor = color;
}
