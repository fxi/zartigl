import type { CurrentField } from "./CurrentField";
import advectFrag from "./shaders/advect.frag.glsl";
import quadVert from "./shaders/quad.vert.glsl";
import trailFrag from "./shaders/trail.frag.glsl";
import trailVert from "./shaders/trail.vert.glsl";
import { Program, type ViewFrame } from "./view";

export interface ParticleStyle {
  ramp: WebGLTexture;
  maxSpeed: number;
  /** Css px per frame at maxSpeed. */
  speed: number;
  opacity: number;
  /** Per-frame respawn probability. */
  drop: number;
}

/**
 * Particles advected on the unit sphere. Each step writes the new state and
 * a ring-buffer history layer in one MRT pass; trails are drawn from the
 * history, so they reproject with the view instead of smearing on screen.
 */
export class SphereParticles {
  private readonly advect: Program;
  private readonly trail: Program;
  private readonly states: WebGLTexture[];
  private readonly history: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private current = 0;
  private head = 0;
  private reset = true;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly size = 256,
    readonly slots = 16,
  ) {
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("Float render targets are not supported");
    }
    this.advect = new Program(gl, quadVert, advectFrag);
    this.trail = new Program(gl, trailVert, trailFrag);
    this.states = [this.stateTexture(), this.stateTexture()];
    this.history = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.history);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, size, size, slots);
    this.nearest(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    this.framebuffer = gl.createFramebuffer();
    // Attribute-less draws still want a bound vertex array.
    this.vao = gl.createVertexArray();
  }

  /** Respawn every particle inside the visible cap on the next step. */
  respawn(): void {
    this.reset = true;
  }

  step(
    frame: ViewFrame,
    field: CurrentField,
    ms: number,
    style: ParticleStyle,
  ): void {
    const gl = this.gl;
    const p = this.advect.use();
    if (!field.bind(p, ms)) {
      return;
    }
    const next = 1 - this.current;
    const slot = (this.head + 1) % this.slots;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.states[next],
      0,
    );
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      this.history,
      0,
      slot,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.size, this.size);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    p.texture("u_state", 2, this.states[this.current]);
    p.mat3("u_rot_inv", frame.rotInv);
    p.float("u_step", style.speed / frame.pxPerRadian);
    p.float("u_max_speed", style.maxSpeed);
    p.float("u_keep_cos", Math.cos(visibleCap(frame)));
    p.float("u_drop", style.drop);
    p.float("u_seed", Math.random() * 100);
    p.float("u_reset", this.reset ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.current = next;
    this.head = slot;
    this.reset = false;
  }

  draw(frame: ViewFrame, style: ParticleStyle): void {
    const gl = this.gl;
    const p = this.trail.use();
    p.projection(frame);
    p.texture("u_history", 0, this.history, gl.TEXTURE_2D_ARRAY);
    p.int("u_head", this.head);
    p.int("u_slots", this.slots);
    p.int("u_size", this.size);
    p.mat3("u_rot", frame.rot);
    p.float("u_max_jump", Math.max(24, style.speed * 12));
    p.texture("u_ramp", 1, style.ramp);
    p.float("u_opacity", style.opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.LINES, 0, this.size * this.size * (this.slots - 1) * 2);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  destroy(): void {
    const gl = this.gl;
    this.advect.delete();
    this.trail.delete();
    for (const texture of this.states) {
      gl.deleteTexture(texture);
    }
    gl.deleteTexture(this.history);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteVertexArray(this.vao);
  }

  private stateTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, this.size, this.size);
    this.nearest(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  private nearest(target: number): void {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
