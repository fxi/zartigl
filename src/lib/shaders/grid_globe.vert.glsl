precision highp float;

attribute vec2 a_grid_uv;

uniform mat4 u_matrix;
uniform vec4 u_geo_bounds;      // west, south, east, north in degrees
uniform vec3 u_globe_center;    // visible hemisphere center in unit-sphere coords

varying vec2 v_geo_uv;
varying float v_front;

void main() {
    float lng = mix(u_geo_bounds.x, u_geo_bounds.z, a_grid_uv.x);
    float lat = mix(u_geo_bounds.y, u_geo_bounds.w, a_grid_uv.y);
    float lngRad = radians(lng);
    float latRad = radians(lat);
    float cosLat = cos(latRad);
    vec3 ecef = vec3(
        sin(lngRad) * cosLat,
        sin(latRad),
        cos(lngRad) * cosLat
    );

    v_geo_uv = a_grid_uv;
    v_front = dot(ecef, u_globe_center);
    gl_Position = u_matrix * vec4(ecef, 1.0);
}
