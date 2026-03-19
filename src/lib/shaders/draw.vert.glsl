precision highp float;

attribute float a_index;
attribute float a_is_curr;   // 0 = back-projected prev endpoint, 1 = current endpoint

uniform sampler2D u_particles;
uniform float u_particles_res;
uniform sampler2D u_velocity;
uniform vec2 u_velocity_min;
uniform vec2 u_velocity_max;
uniform mat4 u_matrix;
uniform float u_world_size;   // 512 * 2^zoom
uniform float u_world_offset; // integer world copy offset (0 = primary, ±1 = copies)
uniform float u_speed_factor;
uniform vec4 u_geo_bounds;   // west, south, east, north in degrees
uniform float u_is_globe;    // 1.0 = globe projection, 0.0 = mercator

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
    float row = floor(a_index / u_particles_res);
    float col = a_index - row * u_particles_res;
    vec2 texCoord = (vec2(col, row) + 0.5) / u_particles_res;

    vec4 encoded = texture2D(u_particles, texCoord);
    vec2 currPos = vec2(encoded.r + encoded.g / 255.0, encoded.b + encoded.a / 255.0);

    float lng = mercToLng(currPos.x);
    float lat = mercToLat(currPos.y);
    vec2 geoUV = vec2(
        fract((lng - u_geo_bounds.x) / (u_geo_bounds.z - u_geo_bounds.x)),
        (lat - u_geo_bounds.y) / (u_geo_bounds.w - u_geo_bounds.y)
    );

    vec4 velSample = texture2D(u_velocity, geoUV);
    v_valid = velSample.a;
    vec2 velocity = mix(u_velocity_min, u_velocity_max, velSample.rg);
    float speed = length(velocity);
    float maxSpeed = length(max(abs(u_velocity_min), abs(u_velocity_max)));
    v_speed = clamp(speed / max(maxSpeed, 0.001), 0.0, 1.0);

    // Reconstruct previous position analytically (same formula as update shader).
    // This avoids reading a prev-state texture and eliminates all teleport artifacts.
    float cosLat = cos(radians(lat));
    float distortion = max(cosLat, 0.01);
    vec2 offset = vec2(
        velocity.x / distortion,
        -velocity.y
    ) * u_speed_factor * 0.0001;

    // a_is_curr=0 → tail of the segment (one step back), a_is_curr=1 → head (current)
    vec2 pos = currPos - offset * (1.0 - a_is_curr);

    if (u_is_globe > 0.5) {
        // MapLibre globe matrix maps from a unit sphere (radius=1) to clip space.
        // Axis convention (from MapLibre's angularCoordinatesRadiansToVector):
        //   x = sin(lng) * cos(lat),  y = sin(lat),  z = cos(lng) * cos(lat)
        float lngRad = radians(mercToLng(pos.x));
        float latRad = radians(mercToLat(pos.y));
        float cosLat = cos(latRad);
        vec3 ecef = vec3(
            sin(lngRad) * cosLat,
            sin(latRad),
            cos(lngRad) * cosLat
        );
        gl_Position = u_matrix * vec4(ecef, 1.0);
    } else {
        vec2 worldPos = vec2((pos.x + u_world_offset) * u_world_size, pos.y * u_world_size);
        gl_Position = u_matrix * vec4(worldPos, 0.0, 1.0);
    }
}
