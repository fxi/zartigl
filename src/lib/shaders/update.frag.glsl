precision highp float;

uniform sampler2D u_particles;
uniform sampler2D u_velocity;
uniform vec2 u_velocity_min;
uniform vec2 u_velocity_max;
uniform float u_speed;        // max pixels/frame for the fastest current (zoom-independent)
uniform float u_world_size;   // 512 * 2^zoom — Mercator [0,1] → screen pixels
uniform float u_rand_seed;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;
uniform vec4 u_bounds; // minX, minY, maxX, maxY in mercator [0,1] or lat/lon [0,1] (globe)
uniform vec4 u_geo_bounds; // west, south, east, north in degrees
uniform float u_is_globe; // 1.0 = globe mode (lat/lon Y), 0.0 = mercator

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

bool invalidNormalizedPosition(vec2 p) {
    return p.x != p.x || p.y != p.y ||
           p.x < 0.0 || p.x > 1.0 ||
           p.y < 0.0 || p.y > 1.0;
}

bool invalidWrappedPosition(vec2 p) {
    return p.x != p.x || p.y != p.y ||
           p.y < 0.0 || p.y > 1.0;
}

void main() {
    vec4 encoded = texture2D(u_particles, v_tex_coord);

#ifdef USE_FLOAT_STATE
    // Float state texture: position stored directly at full precision.
    vec2 pos = encoded.rg;
#else
    // Decode position: R=hi_x, G=lo_x, B=hi_y, A=lo_y
    vec2 pos = vec2(
        encoded.r + encoded.g / 255.0,
        encoded.b + encoded.a / 255.0
    );
#endif

    bool invalidInputPos = invalidNormalizedPosition(pos);
    if (invalidInputPos) {
        pos = vec2(0.5);
    }

    // Convert position to geographic for velocity lookup.
    // Globe mode: pos.y encodes lat as (lat+90)/180; Mercator mode: standard Web Mercator.
    float lng = mercToLng(pos.x);
    float lat = u_is_globe > 0.5 ? (pos.y * 180.0 - 90.0) : mercToLat(pos.y);

    // Velocity texture UV from actual data geographic bounds
    float geoWidth = max(abs(u_geo_bounds.z - u_geo_bounds.x), 1e-6);
    float geoHeight = max(abs(u_geo_bounds.w - u_geo_bounds.y), 1e-6);
    vec2 geoUV = vec2(
        fract((lng - u_geo_bounds.x) / geoWidth),
        (lat - u_geo_bounds.y) / geoHeight
    );
    float inDataY = step(0.0, geoUV.y) * step(geoUV.y, 1.0);

    // Sample velocity and decode from normalized [0,1] back to physical
    vec2 velNorm = texture2D(u_velocity, geoUV).rg;
    vec2 velocity = mix(u_velocity_min, u_velocity_max, velNorm);
    float speed = length(velocity);

    // Mercator distortion correction
    float cosLat = cos(radians(lat));
    float distortion = max(cosLat, 0.01);

    // Constant visual speed: normalize the current by the field max, scale by
    // u_speed (pixels/frame for the fastest current), then convert pixels →
    // Mercator [0,1] by dividing by world_size. Result: offset_px = vn * u_speed
    // is independent of zoom (offset_merc shrinks as you zoom in).
    float maxSpeed = length(max(abs(u_velocity_min), abs(u_velocity_max)));
    vec2 vn = velocity / max(maxSpeed, 1e-6);

    // Visual-speed model. bias = 0 -> pure pixel-constant; a small +bias makes a
    // zoomed-in (sparser) view a touch faster and a zoomed-out view a touch slower,
    // which reads as constant to the eye. u_speed = px/frame at the reference zoom.
    // NOTE: must stay identical to draw.vert.glsl.
    const float SPEED_ZOOM_BIAS = 0.2;        // internal, baked
    const float WORLD_REF = 512.0 * 32.0;     // zoom 5 pivot
    float safeWorldSize = max(abs(u_world_size), 1.0);
    float zoomScale = pow(safeWorldSize / WORLD_REF, SPEED_ZOOM_BIAS);

    // Euler integration. In Mercator, Y decreases northward so V is negated.
    // In globe lat/lon mode, Y increases northward so V keeps its sign.
    vec2 offset = vec2(
        vn.x / distortion,
        u_is_globe > 0.5 ? vn.y : -vn.y
    ) * u_speed * zoomScale / safeWorldSize;

    // Random respawn logic
    // Use v_tex_coord (unique per particle) to prevent merged particles
    // from getting identical random values and staying permanently fused.
    vec2 rng_id = pos + v_tex_coord;

#ifdef USE_FLOAT_STATE
    // Float state has no quantization floor — integrate the exact offset.
    vec2 newPos = pos + offset;
#else
    // Stochastic sub-pixel motion: when offset is below the 16-bit encoding
    // precision (1/65025), the position would never change. Instead, randomly
    // advance by one minimum step with probability |offset| / MIN_STEP so the
    // average speed is preserved and slow particles still move visibly.
    const float MIN_STEP = 1.0 / 65025.0;
    vec2 prob = clamp(abs(offset) / MIN_STEP, 0.0, 1.0);
    float rx = rand(rng_id + vec2(u_rand_seed * 1.7 + 4.3, 2.1));
    float ry = rand(rng_id + vec2(2.1, u_rand_seed * 1.7 + 4.3));
    vec2 stochStep = sign(offset) * MIN_STEP * vec2(
        step(1.0 - prob.x, rx),
        step(1.0 - prob.y, ry)
    );
    // Component-wise: use stochastic step when offset is below threshold
    vec2 belowThreshold = 1.0 - step(MIN_STEP, abs(offset));
    vec2 finalOffset = mix(offset, stochStep, belowThreshold);

    vec2 newPos = pos + finalOffset;
#endif

    // Wrap longitude: a particle crossing ±180° continues on the other side
    // instead of being dropped. Y (latitude) is intentionally not wrapped —
    // the outOfBounds drop below handles polar exit.
    bool invalidNewPos = invalidWrappedPosition(newPos);
    if (!invalidNewPos) {
        newPos.x = fract(newPos.x);
    }

    float dropRate = u_drop_rate + speed * u_drop_rate_bump;
    float drop = step(1.0 - dropRate, rand(rng_id + u_rand_seed));

    // Drop if on land / no data (alpha channel = validity mask)
    float valid = texture2D(u_velocity, geoUV).a * inDataY;
    float outOfData = 1.0 - step(0.5, valid);

    // Also drop if out of viewport bounds
    float outOfBounds = step(newPos.x, u_bounds.x) +
                         step(u_bounds.z, newPos.x) +
                         step(newPos.y, u_bounds.y) +
                         step(u_bounds.w, newPos.y);
    outOfBounds = clamp(outOfBounds, 0.0, 1.0);

    if (invalidNormalizedPosition(newPos)) {
        invalidNewPos = true;
    }
    drop = max(drop, max(outOfData, outOfBounds));
    bool forceRespawn = invalidInputPos || invalidNewPos;
    if (forceRespawn) {
        drop = 1.0;
    }

    // Random position within viewport bounds
    vec2 randomPos = vec2(
        mix(u_bounds.x, u_bounds.z, rand(rng_id + 1.3 + u_rand_seed)),
        mix(u_bounds.y, u_bounds.w, rand(rng_id + 2.1 + u_rand_seed))
    );

    if (forceRespawn) {
        newPos = randomPos;
    } else {
        newPos = mix(newPos, randomPos, drop);
    }

#ifdef USE_FLOAT_STATE
    // Store position directly at full precision (B/A unused).
    gl_FragColor = vec4(newPos, 0.0, 1.0);
#else
    // Encode back to RGBA: R=hi_x, G=lo_x, B=hi_y, A=lo_y
    gl_FragColor = vec4(
        floor(newPos.x * 255.0) / 255.0,
        fract(newPos.x * 255.0),
        floor(newPos.y * 255.0) / 255.0,
        fract(newPos.y * 255.0)
    );
#endif
}
