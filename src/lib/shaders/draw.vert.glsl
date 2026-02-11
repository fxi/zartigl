precision highp float;

attribute float a_index;

uniform sampler2D u_particles;
uniform float u_particles_res;
uniform sampler2D u_velocity;
uniform vec2 u_velocity_min;
uniform vec2 u_velocity_max;
uniform mat4 u_matrix;
uniform float u_world_size;  // 512 * 2^zoom
uniform float u_point_size;
uniform vec4 u_geo_bounds;   // west, south, east, north in degrees

varying float v_speed;
varying float v_valid;

const float PI = 3.141592653589793;

float mercToLng(float x) {
    return x * 360.0 - 180.0;
}

float mercToLat(float y) {
    float y2 = (1.0 - y * 2.0) * PI;
    float ey = exp(y2);
    return degrees(atan(0.5 * (ey - 1.0 / ey)));
}

void main() {
    // Convert particle index to texture coordinate
    float row = floor(a_index / u_particles_res);
    float col = a_index - row * u_particles_res;
    vec2 texCoord = (vec2(col, row) + 0.5) / u_particles_res;

    // Decode mercator position: R=hi_x, G=lo_x, B=hi_y, A=lo_y
    vec4 encoded = texture2D(u_particles, texCoord);
    vec2 pos = vec2(
        encoded.r + encoded.g / 255.0,
        encoded.b + encoded.a / 255.0
    );

    // Lookup velocity for speed-based coloring
    float lng = mercToLng(pos.x);
    float lat = mercToLat(pos.y);
    vec2 geoUV = vec2(
        (lng - u_geo_bounds.x) / (u_geo_bounds.z - u_geo_bounds.x),
        (lat - u_geo_bounds.y) / (u_geo_bounds.w - u_geo_bounds.y)
    );
    vec4 velSample = texture2D(u_velocity, geoUV);
    v_valid = velSample.a;
    vec2 velNorm = velSample.rg;
    vec2 velocity = mix(u_velocity_min, u_velocity_max, velNorm);
    float speed = length(velocity);
    float maxSpeed = length(max(abs(u_velocity_min), abs(u_velocity_max)));
    v_speed = clamp(speed / max(maxSpeed, 0.001), 0.0, 1.0);

    // MapLibre's modelViewProjectionMatrix expects world coords in [0, worldSize]
    vec2 worldPos = pos * u_world_size;
    gl_Position = u_matrix * vec4(worldPos, 0.0, 1.0);
    gl_PointSize = u_point_size;
}
