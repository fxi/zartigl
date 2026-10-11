import type { CurrentField } from "./CurrentField";
import advectFrag from "./shaders/advect.frag.glsl";
import drawFrag from "./shaders/draw.frag.glsl";
import drawVert from "./shaders/draw.vert.glsl";
import fadeFrag from "./shaders/fade.frag.glsl";
import quadVert from "./shaders/quad.vert.glsl";
import { Program, type ViewFrame } from "./view";

export interface ParticleStyle {
  ramp: WebGLTexture;
  maxSpeed: number;
  /** Css px per frame at maxSpeed. */
  speed: number;
  /** Particles drawn, the first ones by index. */
  count: number;
  /** Per-frame respawn probability. */
  drop: number;
  /** Respawn probability added per m/s. */
  dropBump: number;
}

/**
 * zartigl's particle renderer on the unit sphere: particles are advected on
 * the sphere, so any projection and the poles work, and each frame draws one
 * segment per particle into a screen texture that fades a little every
 * frame, which builds the trails.
 */
export class SphereParticles {
  private readonly advect: Program;
  private readonly draw: Program;
  private readonly fade: Program;
  private readonly states: WebGLTexture[];
  private readonly framebuffer: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private screens: WebGLTexture[] = [];
  private width = 0;
  private height = 0;
  private current = 0;
  private reset = true;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly size = 512,
  ) {
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("Float render targets are not supported");
    }
    this.advect = new Program(gl, quadVert, advectFrag);
    this.draw = new Program(gl, drawVert, drawFrag);
    this.fade = new Program(gl, quadVert, fadeFrag);
    this.states = [
      this.texture(gl.RGBA32F, size, size),
      this.texture(gl.RGBA32F, size, size),
    ];
    this.framebuffer = gl.createFramebuffer();
    // Attribute-less draws still want a bound vertex array.
    this.vao = gl.createVertexArray();
  }

  /** Screen textures follow the drawing buffer; trails restart. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }
    const gl = this.gl;
    for (const texture of this.screens) {
      gl.deleteTexture(texture);
    }
    this.width = width;
    this.height = height;
    this.screens = [
      this.texture(gl.RGBA8, width, height),
      this.texture(gl.RGBA8, width, height),
    ];
    this.clear();
  }

  /** Erase the trails. */
  clear(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    for (const texture of this.screens) {
      this.target(texture);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Respawn every particle inside the visible cap on the next step. */
  respawn(): void {
    this.reset = true;
  }

  /** Advect the particles one frame; false until the field has a frame. */
  step(
    frame: ViewFrame,
    field: CurrentField,
    ms: number,
    style: ParticleStyle,
  ): boolean {
    const gl = this.gl;
    const p = this.advect.use();
    if (!field.bind(p, ms)) {
      return false;
    }
    const next = 1 - this.current;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.target(this.states[next]);
    gl.viewport(0, 0, this.size, this.size);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    p.texture("u_state", 2, this.states[this.current]);
    p.mat3("u_rot_inv", frame.rotInv);
    p.float("u_step", style.speed / frame.pxPerRadian);
    p.float("u_max_speed", style.maxSpeed);
    p.float("u_keep_cos", Math.cos(visibleCap(frame)));
    p.float("u_drop", style.drop);
    p.float("u_drop_bump", style.dropBump);
    p.float("u_seed", Math.random() * 100);
    p.float("u_reset", this.reset ? 1 : 0);
    this.quad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.current = next;
    this.reset = false;
    return true;
  }

  /**
   * Fade the trails by `fadeOpacity` and draw the last step's segments into
   * them, as zartigl's fade and draw passes.
   */
  trace(
    frame: ViewFrame,
    field: CurrentField,
    ms: number,
    style: ParticleStyle,
    fadeOpacity: number,
  ): void {
    const gl = this.gl;
    const [previous, next] = this.screens;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.target(next);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const f = this.fade.use();
    f.texture("u_screen", 0, previous);
    f.float("u_opacity", fadeOpacity);
    this.quad();

    const p = this.draw.use();
    if (field.bind(p, ms)) {
      p.projection(frame);
      p.texture("u_prev", 2, this.states[1 - this.current]);
      p.texture("u_curr", 3, this.states[this.current]);
      p.int("u_size", this.size);
      p.mat3("u_rot", frame.rot);
      p.float("u_max_jump", Math.max(16, style.speed * 8));
      p.texture("u_ramp", 4, style.ramp);
      p.float("u_opacity", 1);
      gl.enable(gl.BLEND);
      // Straight color over the trails, alpha accumulated as coverage
      // (shaders/fade.frag.glsl).
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      );
      gl.bindVertexArray(this.vao);
      gl.drawArrays(
        gl.LINES,
        0,
        Math.min(style.count, this.size * this.size) * 2,
      );
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.screens = [next, previous];
  }

  /** Composite the trails over the bound canvas framebuffer. */
  present(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    const f = this.fade.use();
    f.texture("u_screen", 0, this.screens[0]);
    f.float("u_opacity", 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.quad();
    gl.disable(gl.BLEND);
  }

  destroy(): void {
    const gl = this.gl;
    this.advect.delete();
    this.draw.delete();
    this.fade.delete();
    for (const texture of [...this.states, ...this.screens]) {
      gl.deleteTexture(texture);
    }
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteVertexArray(this.vao);
  }

  private target(texture: WebGLTexture): void {
    const gl = this.gl;
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  }

  private quad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private texture(format: number, width: number, height: number) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }
}

/**
 * Angular radius (radians) of the cap worth simulating: the clip, narrowed
 * to the viewport's half diagonal when zoomed in.
 */
export function visibleCap(frame: ViewFrame): number {
  const clip = (Math.min(frame.clipAngle, 180) * Math.PI) / 180;
  const halfDiagonal = Math.hypot(frame.width, frame.height) / 2;
  return Math.min(clip, (1.15 * halfDiagonal) / frame.pxPerRadian);
}
