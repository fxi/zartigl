// Vibrance: saturate muted colors more than vivid ones; v in [-1, 1].
vec3 applyVibrance(vec3 c, float v) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float boost = v * (1.0 - (mx - mn));
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    return mix(vec3(luma), c, 1.0 + boost);
}
