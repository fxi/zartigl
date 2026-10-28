import palettesJson from "./palettes.json";

export type ColorRampInput =
  | string // palette ID → look up palettes.json
  | string[] // hex array → evenly-spaced stops
  | Record<number, string>; // stops map → current API

export interface PaletteMeta {
  id: string;
  label: string;
  tags: string[];
  colors: string[];
}

type PalettesJson = Record<
  string,
  { label: string; tags: string[]; colors: string[] }
>;

/** Shape of an alpha fade inside its zone; the same curves as `logScale`. */
export type AlphaFadeCurve = "linear" | "log" | "exp";

/**
 * Transparent ends of a ramp, as fractions of the ramp from each end: `low`
 * fades the lowest values in from transparent, `high` fades the highest out.
 */
export interface AlphaFade {
  low?: number;
  high?: number;
  curve?: AlphaFadeCurve;
}

/** Ramp positions sampled when a fade rewrites the alpha of a ramp. */
const ALPHA_FADE_SAMPLES = 64;

const ALPHA_FADE_CURVES: Record<AlphaFadeCurve, (x: number) => number> = {
  linear: (x) => x,
  // Rises fast: values just inside the zone already show.
  log: (x) => Math.log10(1 + 9 * x),
  // Stays faint longer: codec noise at the end of the range stays hidden.
  exp: (x) => (10 ** x - 1) / 9,
};

/** Alpha factor at ramp position `t` in [0, 1]; the stricter end wins. */
export function alphaFadeAt(t: number, fade: AlphaFade): number {
  const shape = ALPHA_FADE_CURVES[fade.curve ?? "linear"];
  const low = fade.low ?? 0;
  const high = fade.high ?? 0;
  let alpha = 1;
  if (low > 0 && t < low) {
    alpha = Math.min(alpha, shape(Math.max(t, 0) / low));
  }
  if (high > 0 && t > 1 - high) {
    alpha = Math.min(alpha, shape(Math.max(1 - t, 0) / high));
  }
  return alpha;
}

type Rgba = [number, number, number, number];

function parseHex(color: string): Rgba {
  let hex = color.replace("#", "");
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((c) => c + c).join("");
  }
  const channel = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [
    channel(0),
    channel(2),
    channel(4),
    hex.length === 8 ? channel(6) : 255,
  ];
}

function toHex([r, g, b, a]: Rgba): string {
  return `#${[r, g, b, a]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Color of sorted stops at `t`, interpolated as a canvas gradient does. */
function colorAt(stops: [number, Rgba][], t: number): Rgba {
  if (t <= stops[0][0]) {
    return stops[0][1];
  }
  for (let i = 1; i < stops.length; i++) {
    const [position, color] = stops[i];
    if (t <= position) {
      const [previous, from] = stops[i - 1];
      const k =
        position === previous ? 1 : (t - previous) / (position - previous);
      return from.map((v, c) => v + (color[c] - v) * k) as Rgba;
    }
  }
  return stops[stops.length - 1][1];
}

function withAlphaFade(
  ramp: Record<number, string>,
  fade: AlphaFade,
): Record<number, string> {
  const stops = Object.entries(ramp)
    .map(
      ([position, color]) =>
        [Number(position), parseHex(color)] as [number, Rgba],
    )
    .sort((a, b) => a[0] - b[0]);
  const result: Record<number, string> = {};
  for (let i = 0; i <= ALPHA_FADE_SAMPLES; i++) {
    const t = i / ALPHA_FADE_SAMPLES;
    const [r, g, b, a] = colorAt(stops, t);
    result[t] = toHex([r, g, b, a * alphaFadeAt(t, fade)]);
  }
  return result;
}

const fades = (fade: AlphaFade | undefined): fade is AlphaFade =>
  !!fade && ((fade.low ?? 0) > 0 || (fade.high ?? 0) > 0);

function colorsToStops(colors: string[]): Record<number, string> {
  const stops: Record<number, string> = {};
  const last = colors.length - 1;
  colors.forEach((hex, i) => {
    stops[last === 0 ? 0 : i / last] = hex;
  });
  return stops;
}

/**
 * Stops of a ramp, reversed on request, then with `alphaFade` multiplied into
 * the alpha of its ends. The fade follows positions, not colors: on a reversed
 * ramp it still fades the low values.
 */
export function resolveColorRamp(
  input: ColorRampInput,
  options?: { reverse?: boolean; alphaFade?: AlphaFade },
): Record<number, string> {
  const ramp = orientedRamp(input, options?.reverse ?? false);
  return fades(options?.alphaFade)
    ? withAlphaFade(ramp, options.alphaFade)
    : ramp;
}

function orientedRamp(
  input: ColorRampInput,
  reverse: boolean,
): Record<number, string> {
  const palettes = palettesJson as PalettesJson;

  if (typeof input === "string") {
    const entry = palettes[input];
    if (!entry) {
      throw new Error(
        `Palette "${input}" not found. Available palettes: ${Object.keys(
          palettes,
        ).join(", ")}`,
      );
    }
    const colors = reverse ? [...entry.colors].reverse() : entry.colors;
    return colorsToStops(colors);
  }

  if (Array.isArray(input)) {
    const colors = reverse ? [...input].reverse() : input;
    return colorsToStops(colors);
  }

  if (!reverse) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input).map(([stop, color]) => [1 - Number(stop), color]),
  );
}

/**
 * Palettes to offer, without deprecated ones (still resolvable for old
 * configs) unless `includeDeprecated`.
 */
export function getPalettes(
  options: { includeDeprecated?: boolean } = {},
): PaletteMeta[] {
  const palettes = palettesJson as PalettesJson;
  return Object.entries(palettes)
    .map(([id, entry]) => ({ id, ...entry }))
    .filter(
      (palette) =>
        options.includeDeprecated || !palette.tags.includes("deprecated"),
    );
}

export function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertSource: string,
  fragSource: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create program");
  }
  const vert = createShader(gl, gl.VERTEX_SHADER, vertSource);
  const frag = createShader(gl, gl.FRAGMENT_SHADER, fragSource);
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${log}`);
  }
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return program;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  filter: number,
  data: ArrayBufferView | null,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create texture");
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data as Uint8Array | null,
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/**
 * Capability + GL constants for the particle-state texture format.
 * Float state stores particle positions directly and avoids the RGBA8 packed
 * coordinate lattice. RGBA8 remains the compatibility fallback.
 */
export interface StateTextureFormat {
  kind: "float32" | "float16" | "rgba8-packed";
  internalFormat: number;
  type: number;
}

function isFramebufferCompleteForTextureFormat(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  type: number,
): boolean {
  const prevTexture = gl.getParameter(
    gl.TEXTURE_BINDING_2D,
  ) as WebGLTexture | null;
  const prevFramebuffer = gl.getParameter(
    gl.FRAMEBUFFER_BINDING,
  ) as WebGLFramebuffer | null;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();

  if (!texture || !framebuffer) {
    if (texture) {
      gl.deleteTexture(texture);
    }
    if (framebuffer) {
      gl.deleteFramebuffer(framebuffer);
    }
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    return false;
  }

  let complete = false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      1,
      1,
      0,
      gl.RGBA,
      type,
      null,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    complete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }

  return complete;
}

export function rgba8StateTextureFormat(
  gl: WebGL2RenderingContext,
): StateTextureFormat {
  return {
    kind: "rgba8-packed",
    internalFormat: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  };
}

/** zartigl renders with WebGL2 only; MapLibre may still fall back to WebGL1. */
export function requireWebGL2(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): WebGL2RenderingContext {
  if (
    typeof WebGL2RenderingContext === "undefined" ||
    !(gl instanceof WebGL2RenderingContext)
  ) {
    throw new Error("zartigl requires WebGL2");
  }
  return gl;
}

/**
 * Detect float-render support and return the texture format to use for
 * particle state. Enables the extensions needed to render into the format.
 */
export function detectStateTextureFormat(
  gl: WebGL2RenderingContext,
): StateTextureFormat {
  const candidates: StateTextureFormat[] = [];
  if (gl.getExtension("EXT_color_buffer_float")) {
    candidates.push(
      { kind: "float32", internalFormat: gl.RGBA32F, type: gl.FLOAT },
      { kind: "float16", internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT },
    );
  } else if (gl.getExtension("EXT_color_buffer_half_float")) {
    candidates.push({
      kind: "float16",
      internalFormat: gl.RGBA16F,
      type: gl.HALF_FLOAT,
    });
  }
  for (const candidate of candidates) {
    if (
      isFramebufferCompleteForTextureFormat(
        gl,
        candidate.internalFormat,
        candidate.type,
      )
    ) {
      return candidate;
    }
  }
  return rgba8StateTextureFormat(gl);
}

export function createTextureFormat(
  gl: WebGL2RenderingContext,
  filter: number,
  data: ArrayBufferView | null,
  width: number,
  height: number,
  internalFormat: number,
  type: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create texture");
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    internalFormat,
    width,
    height,
    0,
    gl.RGBA,
    type,
    data,
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

export function bindTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  unit: number,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

export function createFramebuffer(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) {
    throw new Error("Failed to create framebuffer");
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fb;
}

export function createQuadBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) {
    throw new Error("Failed to create buffer");
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  return buffer;
}

const DEFAULT_COLOR_RAMP: Record<number, string> = {
  0.0: "#3288bd",
  0.1: "#66c2a5",
  0.2: "#abdda4",
  0.3: "#e6f598",
  0.4: "#fee08b",
  0.5: "#fdae61",
  0.6: "#f46d43",
  1.0: "#d53e4f",
};

export function createColorRampTexture(
  gl: WebGL2RenderingContext,
  ramp?: ColorRampInput,
  options?: { reverse?: boolean; alphaFade?: AlphaFade },
): WebGLTexture {
  const colors = resolveColorRamp(ramp ?? DEFAULT_COLOR_RAMP, options);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  for (const [stop, color] of Object.entries(colors)) {
    gradient.addColorStop(Number(stop), color);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 1);

  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create color ramp texture");
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

export interface WebGLRendererInfo {
  vendor: string;
  renderer: string;
  unmaskedVendor?: string;
  unmaskedRenderer?: string;
  version?: string;
}

export function getWebGLRendererInfo(
  gl: WebGL2RenderingContext,
): WebGLRendererInfo {
  const info = gl.getExtension("WEBGL_debug_renderer_info") as {
    UNMASKED_VENDOR_WEBGL: number;
    UNMASKED_RENDERER_WEBGL: number;
  } | null;

  return {
    vendor: String(gl.getParameter(gl.VENDOR) ?? ""),
    renderer: String(gl.getParameter(gl.RENDERER) ?? ""),
    unmaskedVendor: info
      ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL) ?? "")
      : undefined,
    unmaskedRenderer: info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
      : undefined,
    version: String(gl.getParameter(gl.VERSION) ?? ""),
  };
}

/**
 * Save WebGL state that MapLibre depends on.
 */
export interface GLState {
  program: WebGLProgram | null;
  activeTexture: number;
  arrayBuffer: WebGLBuffer | null;
  elementBuffer: WebGLBuffer | null;
  framebuffer: WebGLFramebuffer | null;
  blend: boolean;
  depthTest: boolean;
  stencilTest: boolean;
  viewport: Int32Array;
  blendFunc: [number, number];
}

export function saveGLState(gl: WebGL2RenderingContext): GLState {
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    elementBuffer: gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),
    framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    blend: gl.isEnabled(gl.BLEND),
    depthTest: gl.isEnabled(gl.DEPTH_TEST),
    stencilTest: gl.isEnabled(gl.STENCIL_TEST),
    viewport: gl.getParameter(gl.VIEWPORT),
    blendFunc: [
      gl.getParameter(gl.BLEND_SRC_RGB),
      gl.getParameter(gl.BLEND_DST_RGB),
    ],
  };
}

export function restoreGLState(gl: WebGL2RenderingContext, s: GLState): void {
  gl.useProgram(s.program);
  gl.activeTexture(s.activeTexture);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.elementBuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
  if (s.blend) {
    gl.enable(gl.BLEND);
  } else {
    gl.disable(gl.BLEND);
  }
  if (s.depthTest) {
    gl.enable(gl.DEPTH_TEST);
  } else {
    gl.disable(gl.DEPTH_TEST);
  }
  if (s.stencilTest) {
    gl.enable(gl.STENCIL_TEST);
  } else {
    gl.disable(gl.STENCIL_TEST);
  }
  gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
  gl.blendFunc(s.blendFunc[0], s.blendFunc[1]);
}
