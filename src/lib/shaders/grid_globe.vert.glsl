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
    // A global grid whose east edge stops short of a full turn (GeoVideo
    // archives bound by cell centres) is closed to 360°; its uv then passes
    // 1 and the repeating texture blends across the date line (projversor's
    // meshBounds).
    float width = u_geo_bounds.z - u_geo_bounds.x;
    float east = width >= 359.0 ? u_geo_bounds.x + 360.0 : u_geo_bounds.z;
    float lng = mix(u_geo_bounds.x, east, a_grid_uv.x);
    // Bounds are cell edges, which may pass the poles by half a cell.
    float lat = clamp(mix(u_geo_bounds.y, u_geo_bounds.w, a_grid_uv.y), -90.0, 90.0);
    float lngRad = radians(lng);
    float latRad = radians(lat);
    float cosLat = cos(latRad);
    vec3 ecef = vec3(
        sin(lngRad) * cosLat,
        sin(latRad),
        cos(lngRad) * cosLat
    );

    v_geo_uv = vec2((lng - u_geo_bounds.x) / width, a_grid_uv.y);
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
