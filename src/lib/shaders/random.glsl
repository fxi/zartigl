// Integer hash (PCG, Jarzynski & Olano 2020). fract(sin(x) * 43758.5453)
// keeps only a few hundred distinct values in float32, and fewer on GPUs with
// coarse sin: respawns then fall on rings and spokes.

uint pcg(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

/** Uniform in [0, 1) with 24-bit resolution; one value per (x, y, z). */
float random(uvec3 v) {
    return float(pcg(v.x ^ pcg(v.y ^ pcg(v.z))) >> 8u) * (1.0 / 16777216.0);
}
