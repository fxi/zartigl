import { describe, expect, it, vi } from "vitest";
import { createTexture, detectStateTextureFormat, getWebGLRendererInfo } from "./gl-util";

type FakeGlOptions = {
  extensions?: string[];
  framebufferStatus?: number;
};

function makeFakeGl(options: FakeGlOptions = {}) {
  const extensions = new Set(options.extensions ?? []);
  const debugInfo = {
    UNMASKED_VENDOR_WEBGL: 0x9245,
    UNMASKED_RENDERER_WEBGL: 0x9246,
  };
  return {
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    FLOAT: 0x1406,
    HALF_FLOAT_OES: 0x8d61,
    NEAREST: 0x2600,
    TEXTURE_2D: 0x0de1,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    TEXTURE_BINDING_2D: 0x8069,
    FRAMEBUFFER_BINDING: 0x8ca6,
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    createTexture: vi.fn(() => ({ kind: "texture" })),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    createFramebuffer: vi.fn(() => ({ kind: "framebuffer" })),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => options.framebufferStatus ?? 0x8cd5),
    deleteFramebuffer: vi.fn(),
    deleteTexture: vi.fn(),
    getExtension: vi.fn((name: string) => {
      if (name === "WEBGL_debug_renderer_info") return debugInfo;
      if (name === "OES_texture_half_float" && extensions.has(name)) {
        return { HALF_FLOAT_OES: 0x8d61 };
      }
      return extensions.has(name) ? {} : null;
    }),
    getParameter: vi.fn((key: number) => {
      if (key === 0x1f00) return "Google Inc.";
      if (key === 0x1f01) return "WebKit WebGL";
      if (key === 0x1f02) return "WebGL 1.0";
      if (key === debugInfo.UNMASKED_VENDOR_WEBGL) return "Google Inc. (Intel)";
      if (key === debugInfo.UNMASKED_RENDERER_WEBGL) return "ANGLE (Intel, D3D11)";
      return null;
    }),
  };
}

describe("WebGL utility helpers", () => {
  it("creates RGBA8/UNSIGNED_BYTE textures", () => {
    const gl = makeFakeGl();
    const data = new Uint8Array(16);

    createTexture(gl as unknown as WebGLRenderingContext, gl.NEAREST, data, 2, 2);

    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      2,
      2,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
  });

  it("reports masked and unmasked renderer information when available", () => {
    const gl = makeFakeGl();

    expect(getWebGLRendererInfo(gl as unknown as WebGLRenderingContext)).toEqual({
      vendor: "Google Inc.",
      renderer: "WebKit WebGL",
      unmaskedVendor: "Google Inc. (Intel)",
      unmaskedRenderer: "ANGLE (Intel, D3D11)",
      version: "WebGL 1.0",
    });
  });

  it("uses RGBA8 packed state when float render extensions are missing", () => {
    const gl = makeFakeGl();

    expect(detectStateTextureFormat(gl as unknown as WebGLRenderingContext)).toEqual({
      kind: "rgba8-packed",
      internalFormat: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });
    expect(gl.checkFramebufferStatus).not.toHaveBeenCalled();
  });

  it("uses float state when WebGL1 float texture rendering is framebuffer-complete", () => {
    const gl = makeFakeGl({
      extensions: ["OES_texture_float", "WEBGL_color_buffer_float"],
    });

    expect(detectStateTextureFormat(gl as unknown as WebGLRenderingContext)).toEqual({
      kind: "float32",
      internalFormat: gl.RGBA,
      type: gl.FLOAT,
    });
    expect(gl.checkFramebufferStatus).toHaveBeenCalledWith(gl.FRAMEBUFFER);
  });

  it("uses half-float state when float32 is unavailable but half-float rendering is complete", () => {
    const gl = makeFakeGl({
      extensions: ["OES_texture_half_float", "EXT_color_buffer_half_float"],
    });

    expect(detectStateTextureFormat(gl as unknown as WebGLRenderingContext)).toEqual({
      kind: "float16",
      internalFormat: gl.RGBA,
      type: gl.HALF_FLOAT_OES,
    });
    expect(gl.checkFramebufferStatus).toHaveBeenCalledWith(gl.FRAMEBUFFER);
  });

  it("falls back to RGBA8 when advertised float rendering is framebuffer-incomplete", () => {
    const gl = makeFakeGl({
      extensions: ["OES_texture_float", "WEBGL_color_buffer_float"],
      framebufferStatus: 0x8cd6,
    });

    expect(detectStateTextureFormat(gl as unknown as WebGLRenderingContext)).toEqual({
      kind: "rgba8-packed",
      internalFormat: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });
    expect(gl.checkFramebufferStatus).toHaveBeenCalledWith(gl.FRAMEBUFFER);
  });
});
