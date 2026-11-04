precision highp float;

attribute vec2 a_grid_uv;

uniform mat4 u_matrix;
uniform vec4 u_geo_bounds;      // west, south, east, north in degrees
uniform vec4 u_clipping_plane;  // MapLibre globe horizon clipping plane
// MapLibre's globe-to-Mercator interpolation (1 = globe, 0 = Mercator) and the
// matrix that projects Mercator coordinates [0, 1] while it runs.
uniform float u_projection_transition;
uniform mat4 u_fallback_matrix;

varying vec2 v_geo_uv;

const float PI = 3.14159265358979323846;

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
    if (u_projection_transition < 0.999) {
        // As MapLibre's own globe shaders: blend towards the flat position.
        float sinLat = sin(radians(clamp(lat, -85.0, 85.0)));
        vec2 merc = vec2(
            (lng + 180.0) / 360.0,
            0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI)
        );
        vec4 flatPosition = u_fallback_matrix * vec4(merc, 0.0, 1.0);
        float globeness = clamp((u_projection_transition - 0.2) / 0.8, 0.0, 1.0);
        position.z = mix(0.0, position.z, globeness);
        position.xyw = mix(flatPosition.xyw, position.xyw, u_projection_transition);
    }
    gl_Position = position;
}
