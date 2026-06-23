import { describe, expect, it, vi } from "vitest";
import { createTexture, getWebGLRendererInfo } from "./gl-util";

function makeFakeGl() {
  const debugInfo = {
    UNMASKED_VENDOR_WEBGL: 0x9245,
    UNMASKED_RENDERER_WEBGL: 0x9246,
  };
  return {
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    NEAREST: 0x2600,
    TEXTURE_2D: 0x0de1,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    createTexture: vi.fn(() => ({ kind: "texture" })),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    getExtension: vi.fn((name: string) => name === "WEBGL_debug_renderer_info" ? debugInfo : null),
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
});
