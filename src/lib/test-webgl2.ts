import { vi } from "vitest";

/**
 * Test helper: make a fake GL object pass `requireWebGL2`. Node has no
 * WebGL2RenderingContext, so a bare class stands in for it.
 */
export function fakeWebGL2<T extends object>(
  gl: T,
): T & WebGL2RenderingContext {
  if (typeof WebGL2RenderingContext === "undefined") {
    vi.stubGlobal("WebGL2RenderingContext", class {});
  }
  Object.setPrototypeOf(gl, WebGL2RenderingContext.prototype);
  return gl as T & WebGL2RenderingContext;
}
