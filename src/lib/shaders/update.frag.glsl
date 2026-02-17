precision highp float;

uniform sampler2D u_particles;
uniform sampler2D u_velocity;
uniform vec2 u_velocity_min;
uniform vec2 u_velocity_max;
uniform float u_speed_factor;
uniform float u_rand_seed;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;
uniform vec4 u_bounds; // minX, minY, maxX, maxY in mercator [0,1]
uniform vec4 u_geo_bounds; // west, south, east, north in degrees

varying vec2 v_tex_coord;

const float PI = 3.141592653589793;

// PRNG
float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// Mercator [0,1] -> geographic longitude [-180,180]
float mercToLng(float x) {
    return x * 360.0 - 180.0;
}

// Mercator [0,1] -> geographic latitude (degrees)
// sinh not available in GLSL ES 1.0, use (e^x - e^-x)/2
float mercToLat(float y) {
    float y2 = (1.0 - y * 2.0) * PI;
    float ey = exp(y2);
    return degrees(atan(0.5 * (ey - 1.0 / ey)));
}

// Geographic latitude (degrees) -> Mercator Y [0,1]
float latToMercY(float lat) {
    float sinLat = sin(radians(lat));
    float y = 0.5 - 0.5 * log((1.0 + sinLat) / (1.0 - sinLat)) / (2.0 * PI);
    return y;
}

void main() {
    vec4 encoded = texture2D(u_particles, v_tex_coord);

    // Decode position: R=hi_x, G=lo_x, B=hi_y, A=lo_y
    vec2 pos = vec2(
        encoded.r + encoded.g / 255.0,
        encoded.b + encoded.a / 255.0
    );

    // Convert mercator position to geographic for velocity lookup
    float lng = mercToLng(pos.x);
    float lat = mercToLat(pos.y);

    // Velocity texture UV from actual data geographic bounds
    vec2 geoUV = vec2(
        (lng - u_geo_bounds.x) / (u_geo_bounds.z - u_geo_bounds.x),
        (lat - u_geo_bounds.y) / (u_geo_bounds.w - u_geo_bounds.y)
    );

    // Sample velocity and decode from normalized [0,1] back to physical
    vec2 velNorm = texture2D(u_velocity, geoUV).rg;
    vec2 velocity = mix(u_velocity_min, u_velocity_max, velNorm);
    float speed = length(velocity);

    // Mercator distortion correction
    float cosLat = cos(radians(lat));
    float distortion = max(cosLat, 0.01);

    // Euler integration in mercator space
    vec2 offset = vec2(
        velocity.x / distortion,
        -velocity.y               // flip Y: positive V = northward = decreasing mercator Y
    ) * u_speed_factor * 0.0001;

    vec2 newPos = pos + offset;

    // Random respawn logic
    // Use v_tex_coord (unique per particle) to prevent merged particles
    // from getting identical random values and staying permanently fused.
    vec2 rng_id = pos + v_tex_coord;
    float dropRate = u_drop_rate + speed * u_drop_rate_bump;
    float drop = step(1.0 - dropRate, rand(rng_id + u_rand_seed));

    // Drop if on land / no data (alpha channel = validity mask)
    float valid = texture2D(u_velocity, geoUV).a;
    float outOfData = 1.0 - step(0.5, valid);

    // Also drop if out of viewport bounds
    float outOfBounds = step(newPos.x, u_bounds.x) +
                         step(u_bounds.z, newPos.x) +
                         step(newPos.y, u_bounds.y) +
                         step(u_bounds.w, newPos.y);
    outOfBounds = clamp(outOfBounds, 0.0, 1.0);

    drop = max(drop, max(outOfData, outOfBounds));

    // Random position within viewport bounds
    vec2 randomPos = vec2(
        mix(u_bounds.x, u_bounds.z, rand(rng_id + 1.3 + u_rand_seed)),
        mix(u_bounds.y, u_bounds.w, rand(rng_id + 2.1 + u_rand_seed))
    );

    newPos = mix(newPos, randomPos, drop);

    // Encode back to RGBA: R=hi_x, G=lo_x, B=hi_y, A=lo_y
    gl_FragColor = vec4(
        floor(newPos.x * 255.0) / 255.0,
        fract(newPos.x * 255.0),
        floor(newPos.y * 255.0) / 255.0,
        fract(newPos.y * 255.0)
    );
}
