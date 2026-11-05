#version 300 es
precision highp float;
precision highp sampler3D;

// One ray per fragment through the month volume, composited front to back:
// a faint glow of the water column, the three slice planes, and the first
// crossing of the isotherm as a shaded surface. Volumes hold (T · valid,
// valid), so linear filtering never mixes land into the sea (T = r / g).

in vec3 v_world;
out vec4 o_color;

uniform vec3 u_half;
uniform vec3 u_ray;
uniform sampler3D u_vol_a;
uniform sampler3D u_vol_b;
uniform float u_mix;
uniform sampler2D u_lut;
uniform vec2 u_domain;
uniform float u_steps_z;       // depth steps of the volume texture
uniform vec3 u_slice;          // world x, y, z of the slice planes
uniform vec4 u_show;           // glow, slices, isotherm, -
uniform float u_iso;
uniform float u_density;
uniform float u_step;          // march step, world units

const vec3 LAND = vec3(0.13, 0.135, 0.14);
const float SLICE_ALPHA = 0.93;
const float ISO_ALPHA = 0.9;
const int MAX_STEPS = 512;

vec3 uvw(vec3 p) {
    vec3 f = (p + u_half) / (2.0 * u_half);
    float depth = clamp(1.0 - f.z, 0.0, 1.0);
    return vec3(f.x, f.y, (depth * (u_steps_z - 1.0) + 0.5) / u_steps_z);
}

vec2 field(vec3 p) {
    vec3 t = uvw(p);
    return mix(texture(u_vol_a, t).rg, texture(u_vol_b, t).rg, u_mix);
}

float temperature(vec2 s) {
    return s.x / max(s.y, 1e-4);
}

float rampPosition(float t) {
    return clamp((t - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
}

vec3 ramp(float t) {
    return texture(u_lut, vec2(rampPosition(t), 0.5)).rgb;
}

void over(inout vec4 acc, vec3 color, float alpha) {
    acc.rgb += (1.0 - acc.a) * alpha * color;
    acc.a += (1.0 - acc.a) * alpha;
}

void slice(inout vec4 acc, vec3 p) {
    vec2 s = field(p);
    if (s.y < 0.5) {
        over(acc, LAND, 0.8);
        return;
    }
    over(acc, ramp(temperature(s)), SLICE_ALPHA);
}

vec3 isoNormal(vec3 p) {
    // A cell and a half each way: smooth enough not to show the cell edges.
    vec3 h = 3.0 * u_half / vec3(textureSize(u_vol_a, 0));
    float dx = temperature(field(p + vec3(h.x, 0, 0))) - temperature(field(p - vec3(h.x, 0, 0)));
    float dy = temperature(field(p + vec3(0, h.y, 0))) - temperature(field(p - vec3(0, h.y, 0)));
    float dz = temperature(field(p + vec3(0, 0, h.z))) - temperature(field(p - vec3(0, 0, h.z)));
    // Warm water is above: the surface faces up the gradient.
    vec3 g = vec3(dx / h.x, dy / h.y, dz / h.z);
    return length(g) > 0.0 ? normalize(g) : vec3(0.0, 0.0, 1.0);
}

void main() {
    vec3 o = v_world;
    vec3 d = normalize(u_ray);

    // Exit of the box along the ray: the nearest far slab.
    float exit = 1e9;
    for (int i = 0; i < 3; i++) {
        if (abs(d[i]) > 1e-6) {
            exit = min(exit, ((d[i] > 0.0 ? u_half[i] : -u_half[i]) - o[i]) / d[i]);
        }
    }
    if (exit <= 0.0) {
        discard;
    }

    // Slice crossings, nearest first.
    float planes[3];
    for (int i = 0; i < 3; i++) {
        float t = abs(d[i]) > 1e-6 ? (u_slice[i] - o[i]) / d[i] : -1.0;
        planes[i] = (u_show.y > 0.5 && t >= 0.0 && t <= exit) ? t : 1e9;
    }
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2 - i; j++) {
            if (planes[j] > planes[j + 1]) {
                float swap = planes[j];
                planes[j] = planes[j + 1];
                planes[j + 1] = swap;
            }
        }
    }

    int steps = min(MAX_STEPS, int(ceil(exit / u_step)));
    float dt = exit / float(max(steps, 1));
    vec4 acc = vec4(0.0);
    int next = 0;
    float before = 0.0;
    bool beforeValid = false;
    for (int i = 0; i < MAX_STEPS; i++) {
        if (i >= steps || acc.a > 0.97) {
            break;
        }
        float t0 = float(i) * dt;
        float t1 = t0 + dt;
        for (int k = 0; k < 3; k++) {
            if (next == k && planes[k] < t1) {
                slice(acc, o + d * planes[k]);
                next++;
            }
        }
        vec3 p = o + d * (t0 + 0.5 * dt);
        vec2 s = field(p);
        bool valid = s.y > 0.5;
        float temp = temperature(s);
        if (u_show.z > 0.5 && valid && beforeValid && (before - u_iso) * (temp - u_iso) < 0.0) {
            // Bisect between the two samples, so the surface does not band with the step.
            float a = t0 - 0.5 * dt;
            float b = t0 + 0.5 * dt;
            float ta = before;
            for (int k = 0; k < 5; k++) {
                float m = 0.5 * (a + b);
                float tm = temperature(field(o + d * m));
                if ((ta - u_iso) * (tm - u_iso) <= 0.0) {
                    b = m;
                } else {
                    a = m;
                    ta = tm;
                }
            }
            vec3 hit = o + d * (0.5 * (a + b));
            vec3 n = isoNormal(hit);
            float light = 0.35 + 0.65 * abs(dot(n, normalize(vec3(-0.4, -0.5, 0.75))));
            float rim = pow(1.0 - abs(dot(n, -d)), 2.0);
            over(acc, ramp(u_iso) * light + vec3(0.35) * rim, ISO_ALPHA);
        }
        if (u_show.x > 0.5 && valid) {
            float x = rampPosition(temp);
            float a = 1.0 - exp(-u_density * dt * (0.15 + 0.85 * x * x));
            over(acc, ramp(temp), a);
        }
        before = temp;
        beforeValid = valid;
    }
    // Slices behind the last step.
    for (int k = 0; k < 3; k++) {
        if (next == k && planes[k] <= exit) {
            slice(acc, o + d * planes[k]);
            next++;
        }
    }
    o_color = acc;
}
