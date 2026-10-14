// Equirectangular grids on the unit sphere (d3 cartesian frame), row 0 at
// the north edge.

/**
 * Texture coordinates of a unit vector in a west, south, east, north grid;
 * longitudes wrap into the grid, so its west edge may be 0 or -180.
 */
vec2 geoUv(vec3 g, vec4 bounds) {
    float lon = bounds.x + mod(degrees(atan(g.y, g.x)) - bounds.x, 360.0);
    float lat = degrees(asin(clamp(g.z, -1.0, 1.0)));
    return vec2(
        (lon - bounds.x) / (bounds.z - bounds.x),
        (bounds.w - lat) / (bounds.w - bounds.y)
    );
}

/**
 * Whether `uv` falls on the grid; a global grid (view.ts isGlobalGrid)
 * repeats in longitude.
 */
bool onGrid(vec2 uv, vec4 bounds) {
    return uv.y >= 0.0 && uv.y <= 1.0 &&
        (bounds.z - bounds.x >= 359.0 || uv.x <= 1.0);
}
