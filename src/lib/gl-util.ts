import palettesJson from "./palettes.json";

export type ColorRampInput =
  | string                      // palette ID → look up palettes.json
  | string[]                    // hex array → evenly-spaced stops
  | Record<number, string>;     // stops map → current API

export interface PaletteMeta {
  id: string;
  label: string;
  tags: string[];
  colors: string[];
}

type PalettesJson = Record<string, { label: string; tags: string[]; colors: string[] }>;

function colorsToStops(colors: string[]): Record<number, string> {
  const stops: Record<number, string> = {};
  const last = colors.length - 1;
  colors.forEach((hex, i) => {
    stops[last === 0 ? 0 : i / last] = hex;
  });
  return stops;
}

export function resolveColorRamp(
  input: ColorRampInput,
  options?: { reverse?: boolean },
): Record<number, string> {
  const palettes = palettesJson as PalettesJson;

  if (typeof input === "string") {
    const entry = palettes[input];
    if (!entry) {
      throw new Error(
        `Palette "${input}" not found. Available palettes: ${Object.keys(palettes).join(", ")}`,
      );
    }
    const colors = options?.reverse ? [...entry.colors].reverse() : entry.colors;
    return colorsToStops(colors);
  }

  if (Array.isArray(input)) {
    const colors = options?.reverse ? [...input].reverse() : input;
    return colorsToStops(colors);
  }

  // Record<number, string> — return as-is (reverse not applicable to arbitrary stops)
  return input;
}

export function getPalettes(): PaletteMeta[] {
  const palettes = palettesJson as PalettesJson;
  return Object.entries(palettes).map(([id, entry]) => ({ id, ...entry }));
}

export function createShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
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
  gl: WebGLRenderingContext,
  vertSource: string,
  fragSource: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create program");
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
  gl: WebGLRenderingContext,
  filter: number,
  data: ArrayBufferView | null,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Failed to create texture");
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
  float: boolean;
  internalFormat: number;
  type: number;
}

function isFramebufferCompleteForTextureFormat(
  gl: WebGLRenderingContext,
  internalFormat: number,
  type: number,
): boolean {
  const prevTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();

  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
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
    complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }

  return complete;
}

export function rgba8StateTextureFormat(gl: WebGLRenderingContext): StateTextureFormat {
  return { float: false, internalFormat: gl.RGBA, type: gl.UNSIGNED_BYTE };
}

/**
 * Detect float-render support and return the texture format to use for
 * particle state. Enables the extensions needed to render into the format.
 */
export function detectStateTextureFormat(
  gl: WebGLRenderingContext,
): StateTextureFormat {
  const isWebGL2 =
    typeof WebGL2RenderingContext !== "undefined" &&
    gl instanceof WebGL2RenderingContext;

  if (isWebGL2) {
    if (gl.getExtension("EXT_color_buffer_float")) {
      const gl2 = gl as unknown as WebGL2RenderingContext;
      const candidate = { float: true, internalFormat: gl2.RGBA32F, type: gl.FLOAT };
      if (isFramebufferCompleteForTextureFormat(gl, candidate.internalFormat, candidate.type)) {
        return candidate;
      }
    }
  } else {
    const hasFloatTex = gl.getExtension("OES_texture_float");
    const hasFloatRender = gl.getExtension("WEBGL_color_buffer_float");
    if (hasFloatTex && hasFloatRender) {
      const candidate = { float: true, internalFormat: gl.RGBA, type: gl.FLOAT };
      if (isFramebufferCompleteForTextureFormat(gl, candidate.internalFormat, candidate.type)) {
        return candidate;
      }
    }
  }

  return rgba8StateTextureFormat(gl);
}

export function createTextureFormat(
  gl: WebGLRenderingContext,
  filter: number,
  data: ArrayBufferView | null,
  width: number,
  height: number,
  internalFormat: number,
  type: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Failed to create texture");
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
  gl: WebGLRenderingContext,
  texture: WebGLTexture,
  unit: number,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

export function createFramebuffer(
  gl: WebGLRenderingContext,
  texture: WebGLTexture,
): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error("Failed to create framebuffer");
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

export function createQuadBuffer(gl: WebGLRenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("Failed to create buffer");
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
  gl: WebGLRenderingContext,
  ramp?: ColorRampInput,
): WebGLTexture {
  const colors = ramp != null ? resolveColorRamp(ramp) : DEFAULT_COLOR_RAMP;
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
  if (!texture) throw new Error("Failed to create color ramp texture");
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

export function getWebGLRendererInfo(gl: WebGLRenderingContext): WebGLRendererInfo {
  const info = gl.getExtension("WEBGL_debug_renderer_info") as {
    UNMASKED_VENDOR_WEBGL: number;
    UNMASKED_RENDERER_WEBGL: number;
  } | null;

  return {
    vendor: String(gl.getParameter(gl.VENDOR) ?? ""),
    renderer: String(gl.getParameter(gl.RENDERER) ?? ""),
    unmaskedVendor: info ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL) ?? "") : undefined,
    unmaskedRenderer: info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "") : undefined,
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

export function saveGLState(gl: WebGLRenderingContext): GLState {
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

export function restoreGLState(gl: WebGLRenderingContext, s: GLState): void {
  gl.useProgram(s.program);
  gl.activeTexture(s.activeTexture);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.elementBuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
  if (s.blend) gl.enable(gl.BLEND);
  else gl.disable(gl.BLEND);
  if (s.depthTest) gl.enable(gl.DEPTH_TEST);
  else gl.disable(gl.DEPTH_TEST);
  if (s.stencilTest) gl.enable(gl.STENCIL_TEST);
  else gl.disable(gl.STENCIL_TEST);
  gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
  gl.blendFunc(s.blendFunc[0], s.blendFunc[1]);
}
