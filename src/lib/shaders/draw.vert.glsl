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
uniform float u_speed;        // max pixels/frame for the fastest current (zoom-independent)
uniform vec4 u_geo_bounds;   // west, south, east, north in degrees
uniform float u_is_globe;    // 1.0 = globe projection, 0.0 = mercator
uniform vec3 u_globe_center; // visible hemisphere center in unit-sphere coords

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

bool invalidNormalizedPosition(vec2 p) {
    return p.x != p.x || p.y != p.y ||
           p.x < 0.0 || p.x > 1.0 ||
           p.y < 0.0 || p.y > 1.0;
}

bool invalidWrappedPosition(vec2 p) {
    return p.x != p.x || p.y != p.y ||
           p.y < 0.0 || p.y > 1.0;
}

vec3 globeEcef(vec2 p) {
    // MapLibre globe matrix maps from a unit sphere (radius=1) to clip space.
    // Axis convention (from MapLibre's angularCoordinatesRadiansToVector):
    //   x = sin(lng) * cos(lat),  y = sin(lat),  z = cos(lng) * cos(lat)
    float lngRad = radians(mercToLng(p.x));
    float latRad = radians(p.y * 180.0 - 90.0);
    float cosLat = cos(latRad);
    return vec3(
        sin(lngRad) * cosLat,
        sin(latRad),
        cos(lngRad) * cosLat
    );
}

void hideParticle() {
    v_speed = 0.0;
    v_valid = 0.0;
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
}

void main() {
    float row = floor(a_index / u_particles_res);
    float col = a_index - row * u_particles_res;
    vec2 texCoord = (vec2(col, row) + 0.5) / u_particles_res;

    vec4 encoded = texture2D(u_particles, texCoord);
    vec2 currPos = vec2(encoded.r + encoded.g / 255.0, encoded.b + encoded.a / 255.0);

    if (invalidNormalizedPosition(currPos)) {
        hideParticle();
        return;
    }

    float lng = mercToLng(currPos.x);
    float lat = u_is_globe > 0.5 ? (currPos.y * 180.0 - 90.0) : mercToLat(currPos.y);
    float geoWidth = max(abs(u_geo_bounds.z - u_geo_bounds.x), 1e-6);
    float geoHeight = max(abs(u_geo_bounds.w - u_geo_bounds.y), 1e-6);
    vec2 geoUV = vec2(
        fract((lng - u_geo_bounds.x) / geoWidth),
        (lat - u_geo_bounds.y) / geoHeight
    );
    float inDataY = step(0.0, geoUV.y) * step(geoUV.y, 1.0);

    vec4 velSample = texture2D(u_velocity, geoUV);
    v_valid = velSample.a * inDataY;
    vec2 velocity = mix(u_velocity_min, u_velocity_max, velSample.rg);
    float speed = length(velocity);
    float maxSpeed = length(max(abs(u_velocity_min), abs(u_velocity_max)));
    v_speed = clamp(speed / max(maxSpeed, 0.001), 0.0, 1.0);

    // Reconstruct previous position analytically (same formula as update shader).
    // This avoids reading a prev-state texture and eliminates all teleport artifacts.
    // Must match update.frag exactly so the segment equals one simulation step.
    float cosLat = cos(radians(lat));
    float distortion = max(cosLat, 0.01);
    vec2 vn = velocity / max(maxSpeed, 1e-6);

    // Visual-speed model — MUST stay identical to update.frag.glsl.
    const float SPEED_ZOOM_BIAS = 0.2;        // internal, baked
    const float WORLD_REF = 512.0 * 32.0;     // zoom 5 pivot
    float safeWorldSize = max(abs(u_world_size), 1.0);
    float zoomScale = pow(safeWorldSize / WORLD_REF, SPEED_ZOOM_BIAS);

    vec2 offset = vec2(
        vn.x / distortion,
        u_is_globe > 0.5 ? vn.y : -vn.y
    ) * u_speed * zoomScale / safeWorldSize;

    if (offset.x != offset.x || offset.y != offset.y) {
        hideParticle();
        return;
    }

    // Validate the whole GL_LINES segment before selecting either endpoint.
    // If only one endpoint is hidden, WebGL still rasterizes a long interpolated
    // segment from the hidden vertex to the valid one.
    vec2 headPos = currPos;
    vec2 tailPos = currPos - offset;
    float segmentPx = length((headPos - tailPos) * safeWorldSize);
    float maxSegmentPx = max(128.0, u_speed * zoomScale * 160.0);
    if (invalidWrappedPosition(headPos) ||
        invalidWrappedPosition(tailPos) ||
        segmentPx != segmentPx ||
        segmentPx > maxSegmentPx) {
        hideParticle();
        return;
    }

    if (u_is_globe > 0.5) {
        vec3 headEcef = globeEcef(headPos);
        vec3 tailEcef = globeEcef(tailPos);
        if (dot(headEcef, u_globe_center) <= 0.0 ||
            dot(tailEcef, u_globe_center) <= 0.0) {
            hideParticle();
            return;
        }
    }

    // a_is_curr=0 → tail of the segment (one step back), a_is_curr=1 → head (current)
    vec2 pos = mix(tailPos, headPos, a_is_curr);

    if (u_is_globe > 0.5) {
        vec3 ecef = globeEcef(pos);
        gl_Position = u_matrix * vec4(ecef, 1.0);
    } else {
        vec2 worldPos = vec2((pos.x + u_world_offset) * u_world_size, pos.y * u_world_size);
        gl_Position = u_matrix * vec4(worldPos, 0.0, 1.0);
    }
}
