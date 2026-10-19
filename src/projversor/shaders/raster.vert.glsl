#version 300 es
precision highp float;

#include ./project.glsl;

// Scalar raster as a lon/lat mesh over the field bounds: u_cols × u_rows
// cells, two triangles each, no attributes. Every vertex projects its whole
// triangle, as draw.vert.glsl does for segments, so a triangle that crosses
// a projection cut or lies past the clip is dropped as a whole.
uniform vec4 u_grid;        // west, south, east, north in degrees
uniform int u_cols;
uniform int u_rows;
uniform mat3 u_rot;         // geographic -> rotated frame
uniform float u_clip;
uniform float u_max_jump;   // px; longer edges cross a cut

out vec3 v_geo;
out vec3 v_rot;

const ivec2 CORNERS[6] = ivec2[6](
    ivec2(0, 0), ivec2(1, 0), ivec2(0, 1),
    ivec2(1, 0), ivec2(1, 1), ivec2(0, 1)
);

vec3 cornerGeo(int cell, int corner) {
    ivec2 c = ivec2(cell % u_cols, cell / u_cols) + CORNERS[corner];
    float lon = radians(mix(u_grid.x, u_grid.z, float(c.x) / float(u_cols)));
    float lat = radians(mix(u_grid.w, u_grid.y, float(c.y) / float(u_rows)));
    return vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
}

void main() {
    int cell = gl_VertexID / 6;
    int corner = gl_VertexID % 6;
    int first = corner < 3 ? 0 : 3;
    vec2 px[3];
    float nearest = 1e9;
    for (int i = 0; i < 3; i++) {
        vec3 r = u_rot * cornerGeo(cell, first + i);
        nearest = min(nearest, centerDistance(r));
        vec2 ll = lonLat(r);
        px[i] = projectPx(ll.x, ll.y);
    }
    float longest = max(
        distance(px[0], px[1]),
        max(distance(px[1], px[2]), distance(px[2], px[0]))
    );
    // The fragment shader trims triangles that straddle the clip.
    bool visible = nearest <= u_clip && longest < u_max_jump;
    v_geo = cornerGeo(cell, corner);
    v_rot = u_rot * v_geo;
    gl_Position = visible
        ? pxToClip(px[corner - first], 0.0)
        : vec4(2.0, 2.0, 2.0, 1.0);
}
