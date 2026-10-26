// Scalar-luma GeoVideo: red channel of the browser-decoded frame to the
// physical value. scripts/geovideo/render.py writes the codes as gray RGB, so
// the decoded RGB is the code itself: no limited-range inversion, unlike the
// luma codes of vector-luma. Values per geoVideoScalarUniforms().
uniform vec2 u_code_range;   // codeMin / 255, codeMax / 255
uniform vec2 u_value_range;  // valueMin, valueMax

float geoVideoScalarValue(float r) {
    float code = clamp((r - u_code_range.x) / (u_code_range.y - u_code_range.x), 0.0, 1.0);
    return mix(u_value_range.x, u_value_range.y, code);
}
