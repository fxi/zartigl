precision highp float;

attribute vec2 a_grid_uv;

uniform mat4 u_matrix;
uniform vec4 u_geo_bounds;   // west, south, east, north in degrees
uniform float u_world_size;   // 512 * 2^zoom
uniform float u_world_offset; // integer world copy offset

varying vec2 v_geo_uv;

const float PI = 3.14159265358979323846;

float lngToMercX(float lng) {
    return (lng + 180.0) / 360.0;
}

float latToMercY(float lat) {
    float clamped = clamp(lat, -85.0, 85.0);
    float sinLat = sin(radians(clamped));
    return 0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI);
}

void main() {
    float lng = mix(u_geo_bounds.x, u_geo_bounds.z, a_grid_uv.x);
    float lat = mix(u_geo_bounds.y, u_geo_bounds.w, a_grid_uv.y);
    vec2 merc = vec2(lngToMercX(lng) + u_world_offset, latToMercY(lat));
    vec2 worldPos = merc * u_world_size;

    v_geo_uv = a_grid_uv;
    gl_Position = u_matrix * vec4(worldPos, 0.0, 1.0);
}
