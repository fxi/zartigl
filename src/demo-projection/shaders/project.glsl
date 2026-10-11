// Blended world projection, twin of projections.ts (blendRaw). Raw formulas
// must stay identical to d3's so the overlay coastlines match the raster.

uniform int u_proj_a;
uniform int u_proj_b;
uniform float u_ka;       // fit scale of a, px per raw unit
uniform float u_kb;       // fit scale of b
uniform float u_t;        // 0 = a, 1 = b
uniform float u_zoom;
uniform vec2 u_center;    // css px
uniform vec2 u_viewport;  // css px

const float PI = 3.141592653589793;

float mollweideTheta(float phi) {
    float target = PI * sin(phi);
    float x = phi;
    for (int i = 0; i < 12; i++) {
        float den = 1.0 + cos(x);
        if (den < 1e-6) break;
        float d = (x + sin(x) - target) / den;
        x -= d;
        if (abs(d) < 1e-7) break;
    }
    return 0.5 * x;
}

vec2 rawProject(int id, float lam, float phi) {
    if (id == 0) {
        return vec2(lam, phi);
    }
    if (id == 1) {
        // Equal Earth (Šavrič et al.), as d3.geoEqualEarthRaw.
        const float A1 = 1.340264;
        const float A2 = -0.081106;
        const float A3 = 0.000893;
        const float A4 = 0.003796;
        const float M = 0.8660254037844386;
        float l = asin(M * sin(phi));
        float l2 = l * l;
        float l6 = l2 * l2 * l2;
        return vec2(
            lam * cos(l) / (M * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2))),
            l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2))
        );
    }
    if (id == 2) {
        float theta = mollweideTheta(phi);
        return vec2(0.9003163161571061 * lam * cos(theta), 1.4142135623730951 * sin(theta));
    }
    float cy = cos(phi);
    float cxcy = cos(lam) * cy;
    if (id == 5) {
        return vec2(cy * sin(lam), sin(phi));
    }
    float k;
    if (id == 3) {
        k = sqrt(2.0 / max(1.0 + cxcy, 1e-7));
    } else {
        float c = acos(clamp(cxcy, -1.0, 1.0));
        k = c / max(sin(c), 1e-6);
    }
    return vec2(k * cy * sin(lam), k * sin(phi));
}

/** Blended projection in css px, y down, before the viewport transform. */
vec2 projectPx(float lam, float phi) {
    vec2 p;
    if (u_t <= 0.0) {
        p = u_ka * rawProject(u_proj_a, lam, phi);
    } else if (u_t >= 1.0) {
        p = u_kb * rawProject(u_proj_b, lam, phi);
    } else {
        p = mix(u_ka * rawProject(u_proj_a, lam, phi), u_kb * rawProject(u_proj_b, lam, phi), u_t);
    }
    return u_center + u_zoom * vec2(p.x, -p.y);
}

vec4 pxToClip(vec2 px, float depth) {
    return vec4(px.x / u_viewport.x * 2.0 - 1.0, 1.0 - px.y / u_viewport.y * 2.0, depth, 1.0);
}

vec2 lonLat(vec3 r) {
    return vec2(atan(r.y, r.x), asin(clamp(r.z, -1.0, 1.0)));
}

/** Angular distance from the projection center, rotated frame. */
float centerDistance(vec3 r) {
    return acos(clamp(r.x, -1.0, 1.0));
}
