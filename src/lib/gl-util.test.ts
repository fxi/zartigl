import { describe, expect, it, vi } from "vitest";
import { detectStateTextureFormat } from "./gl-util";

type FakeGlOptions = {
  extensions?: string[];
  framebufferStatus?: number;
};

function makeFakeWebGL1(options: FakeGlOptions = {}) {
  const extensions = new Set(options.extensions ?? []);
  const gl = {
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    FLOAT: 0x1406,
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
    getExtension: vi.fn((name: string) => extensions.has(name) ? {} : null),
    getParameter: vi.fn(() => null),
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
  };
  return gl;
}

describe("detectStateTextureFormat", () => {
  it("uses RGBA8 packed state when float render extensions are missing", () => {
    const gl = makeFakeWebGL1();

    const format = detectStateTextureFormat(gl as unknown as WebGLRenderingContext);

    expect(format).toEqual({
      float: false,
      internalFormat: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });
    expect(gl.createTexture).not.toHaveBeenCalled();
    expect(gl.checkFramebufferStatus).not.toHaveBeenCalled();
  });

  it("uses float state when WebGL1 float texture rendering is framebuffer-complete", () => {
    const gl = makeFakeWebGL1({
      extensions: ["OES_texture_float", "WEBGL_color_buffer_float"],
    });

    const format = detectStateTextureFormat(gl as unknown as WebGLRenderingContext);

    expect(format).toEqual({
      float: true,
      internalFormat: gl.RGBA,
      type: gl.FLOAT,
    });
    expect(gl.checkFramebufferStatus).toHaveBeenCalledWith(gl.FRAMEBUFFER);
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
  });

  it("falls back to RGBA8 when advertised float rendering is framebuffer-incomplete", () => {
    const gl = makeFakeWebGL1({
      extensions: ["OES_texture_float", "WEBGL_color_buffer_float"],
      framebufferStatus: 0x8cd6,
    });

    const format = detectStateTextureFormat(gl as unknown as WebGLRenderingContext);

    expect(format).toEqual({
      float: false,
      internalFormat: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    });
    expect(gl.checkFramebufferStatus).toHaveBeenCalledWith(gl.FRAMEBUFFER);
  });
});
