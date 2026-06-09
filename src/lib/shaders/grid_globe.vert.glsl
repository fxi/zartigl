precision highp float;

attribute vec2 a_grid_uv;

uniform mat4 u_matrix;
uniform vec4 u_geo_bounds;      // west, south, east, north in degrees
uniform vec4 u_clipping_plane;  // MapLibre globe horizon clipping plane

varying vec2 v_geo_uv;

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
    vec4 position = u_matrix * vec4(ecef, 1.0);
    position.z = (1.0 - (dot(ecef, u_clipping_plane.xyz) + u_clipping_plane.w)) * position.w;
    gl_Position = position;
}
