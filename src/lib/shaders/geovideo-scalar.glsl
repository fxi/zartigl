// Scalar-luma GeoVideo: red channel of the browser-decoded frame to the
// physical value. scripts/geovideo/render.py writes the codes as gray RGB, so
// the decoded RGB is the code itself: no limited-range inversion, unlike the
// luma codes of vector-luma. Values per geoVideoScalarUniforms().
uniform vec2 u_code_range;       // codeMin / 255, codeMax / 255
uniform vec2 u_value_range;      // valueMin, valueMax
uniform float u_scalar_transfer; // 0 linear; 1 "log10-1p9": codes at log10(1 + 9t)

// The code as [0, 1] across the encoded range, before the transfer.
float geoVideoScalarCode(float r) {
    return clamp((r - u_code_range.x) / (u_code_range.y - u_code_range.x), 0.0, 1.0);
}

float geoVideoScalarValue(float r) {
    float code = geoVideoScalarCode(r);
    float t = mix(code, (pow(10.0, code) - 1.0) / 9.0, u_scalar_transfer);
    return mix(u_value_range.x, u_value_range.y, t);
}
