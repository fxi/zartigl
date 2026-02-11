import {
  createProgram,
  createTexture,
  createFramebuffer,
  createQuadBuffer,
  createColorRampTexture,
  bindTexture,
} from "./gl-util.js";

import quadVert from "./shaders/quad.vert.glsl";
import updateFrag from "./shaders/update.frag.glsl";
import drawVert from "./shaders/draw.vert.glsl";
import drawFrag from "./shaders/draw.frag.glsl";
import fadeFrag from "./shaders/fade.frag.glsl";

export interface SimulationParams {
  particleCount: number;
  speedFactor: number;
  fadeOpacity: number;
  dropRate: number;
  dropRateBump: number;
  pointSize: number;
  colorRamp?: Record<number, string>;
}

const DEFAULTS: SimulationParams = {
  particleCount: 65536,
  speedFactor: 0.25,
  fadeOpacity: 0.996,
  dropRate: 0.003,
  dropRateBump: 0.01,
  pointSize: 1.0,
};

export class ParticleSimulation {
  private gl!: WebGLRenderingContext;
  private params: SimulationParams;

  // Programs
  private updateProgram!: WebGLProgram;
  private drawProgram!: WebGLProgram;
  private fadeProgram!: WebGLProgram;

  // Particle state ping-pong
  private particleStateTextures!: [WebGLTexture, WebGLTexture];
  private particleFramebuffers!: [WebGLFramebuffer, WebGLFramebuffer];
  private particleStateRes!: number;
  private particleIndexBuffer!: WebGLBuffer;
  private numParticles!: number;

  // Screen textures for trail rendering
  private screenTextures!: [WebGLTexture, WebGLTexture];
  private screenFramebuffers!: [WebGLFramebuffer, WebGLFramebuffer];
  private screenWidth = 0;
  private screenHeight = 0;

  // Shared geometry
  private quadBuffer!: WebGLBuffer;
  private colorRampTexture!: WebGLTexture;

  // Uniform locations (cached)
  private updateLocs!: Record<string, WebGLUniformLocation | null>;
  private drawLocs!: Record<string, WebGLUniformLocation | null>;
  private fadeLocs!: Record<string, WebGLUniformLocation | null>;

  constructor(params?: Partial<SimulationParams>) {
    this.params = { ...DEFAULTS, ...params };
  }

  init(gl: WebGLRenderingContext): void {
    this.gl = gl;

    // Compile programs
    this.updateProgram = createProgram(gl, quadVert, updateFrag);
    this.drawProgram = createProgram(gl, drawVert, drawFrag);
    this.fadeProgram = createProgram(gl, quadVert, fadeFrag);

    // Cache uniform locations
    this.updateLocs = this.getUniforms(this.updateProgram, [
      "u_particles",
      "u_velocity",
      "u_velocity_min",
      "u_velocity_max",
      "u_speed_factor",
      "u_rand_seed",
      "u_drop_rate",
      "u_drop_rate_bump",
      "u_bounds",
      "u_geo_bounds",
    ]);
    this.drawLocs = this.getUniforms(this.drawProgram, [
      "u_particles",
      "u_velocity",
      "u_velocity_min",
      "u_velocity_max",
      "u_particles_res",
      "u_matrix",
      "u_world_size",
      "u_point_size",
      "u_color_ramp",
      "u_geo_bounds",
    ]);
    this.fadeLocs = this.getUniforms(this.fadeProgram, [
      "u_screen",
      "u_opacity",
    ]);

    // Shared resources
    this.quadBuffer = createQuadBuffer(gl);
    this.colorRampTexture = createColorRampTexture(gl, this.params.colorRamp);

    // Initialize particle state
    this.initParticleState();
  }

  private getUniforms(
    program: WebGLProgram,
    names: string[],
  ): Record<string, WebGLUniformLocation | null> {
    const result: Record<string, WebGLUniformLocation | null> = {};
    for (const name of names) {
      result[name] = this.gl.getUniformLocation(program, name);
    }
    return result;
  }

  private initParticleState(): void {
    const gl = this.gl;
    const count = this.params.particleCount;
    this.particleStateRes = Math.ceil(Math.sqrt(count));
    this.numParticles = this.particleStateRes * this.particleStateRes;

    // Random initial positions
    const stateData = new Uint8Array(this.numParticles * 4);
    for (let i = 0; i < stateData.length; i++) {
      stateData[i] = Math.floor(Math.random() * 256);
    }

    const res = this.particleStateRes;
    const tex0 = createTexture(gl, gl.NEAREST, stateData, res, res);
    const tex1 = createTexture(gl, gl.NEAREST, stateData, res, res);
    const fb0 = createFramebuffer(gl, tex0);
    const fb1 = createFramebuffer(gl, tex1);

    this.particleStateTextures = [tex0, tex1];
    this.particleFramebuffers = [fb0, fb1];

    // Create particle index buffer for draw call
    const indices = new Float32Array(this.numParticles);
    for (let i = 0; i < this.numParticles; i++) indices[i] = i;
    this.particleIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleIndexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }

  /**
   * Ensure screen textures match the current canvas size.
   */
  resize(width: number, height: number): void {
    if (width === this.screenWidth && height === this.screenHeight) return;

    const gl = this.gl;
    this.screenWidth = width;
    this.screenHeight = height;

    // Clean up old
    if (this.screenTextures) {
      gl.deleteTexture(this.screenTextures[0]);
      gl.deleteTexture(this.screenTextures[1]);
      gl.deleteFramebuffer(this.screenFramebuffers[0]);
      gl.deleteFramebuffer(this.screenFramebuffers[1]);
    }

    const emptyPixels = new Uint8Array(width * height * 4);
    const tex0 = createTexture(gl, gl.NEAREST, emptyPixels, width, height);
    const tex1 = createTexture(gl, gl.NEAREST, emptyPixels, width, height);
    const fb0 = createFramebuffer(gl, tex0);
    const fb1 = createFramebuffer(gl, tex1);

    this.screenTextures = [tex0, tex1];
    this.screenFramebuffers = [fb0, fb1];
  }

  /**
   * Run one simulation step: update positions, fade trails, draw particles.
   * Must be called within the MapLibre render callback.
   */
  render(
    velocityTexUnit: number,
    velocityMin: [number, number],
    velocityMax: [number, number],
    matrix: Iterable<number>,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    worldSize: number,
    geoBounds?: { west: number; south: number; east: number; north: number },
  ): void {
    const gl = this.gl;

    if (this.screenWidth === 0 || this.screenHeight === 0) return;

    // Capture MapLibre's current framebuffer so we can restore it for the final blit
    const mapFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

    // --- 1. Update pass: advance particle positions ---
    // Blending MUST be off: the alpha channel encodes position data (lo byte of Y),
    // not transparency. If blend leaks in, particles snap to 1/255 grid lines.
    gl.disable(gl.BLEND);
    gl.useProgram(this.updateProgram);
    gl.viewport(0, 0, this.particleStateRes, this.particleStateRes);

    // Bind current particle state to unit 0
    bindTexture(gl, this.particleStateTextures[0], 0);
    gl.uniform1i(this.updateLocs["u_particles"], 0);

    // Velocity already bound to velocityTexUnit
    gl.uniform1i(this.updateLocs["u_velocity"], velocityTexUnit);
    gl.uniform2f(
      this.updateLocs["u_velocity_min"],
      velocityMin[0],
      velocityMin[1],
    );
    gl.uniform2f(
      this.updateLocs["u_velocity_max"],
      velocityMax[0],
      velocityMax[1],
    );
    gl.uniform1f(this.updateLocs["u_speed_factor"], this.params.speedFactor);
    gl.uniform1f(this.updateLocs["u_rand_seed"], Math.random());
    gl.uniform1f(this.updateLocs["u_drop_rate"], this.params.dropRate);
    gl.uniform1f(this.updateLocs["u_drop_rate_bump"], this.params.dropRateBump);
    gl.uniform4f(
      this.updateLocs["u_bounds"],
      bounds.minX,
      bounds.minY,
      bounds.maxX,
      bounds.maxY,
    );
    if (geoBounds) {
      gl.uniform4f(
        this.updateLocs["u_geo_bounds"],
        geoBounds.west,
        geoBounds.south,
        geoBounds.east,
        geoBounds.north,
      );
    }

    // Draw fullscreen quad into particle framebuffer 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.particleFramebuffers[1]);
    this.drawQuad();

    // --- 2. Fade pass: write faded trails directly (no blending) ---
    gl.viewport(0, 0, this.screenWidth, this.screenHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.screenFramebuffers[1]);

    gl.useProgram(this.fadeProgram);
    gl.disable(gl.BLEND);

    bindTexture(gl, this.screenTextures[0], 0);
    gl.uniform1i(this.fadeLocs["u_screen"], 0);
    gl.uniform1f(this.fadeLocs["u_opacity"], this.params.fadeOpacity);

    this.drawQuad();

    // --- 3. Draw pass: render particles on top of faded trails ---
    gl.useProgram(this.drawProgram);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    bindTexture(gl, this.particleStateTextures[1], 0);
    gl.uniform1i(this.drawLocs["u_particles"], 0);

    gl.uniform1i(this.drawLocs["u_velocity"], velocityTexUnit);
    gl.uniform2f(
      this.drawLocs["u_velocity_min"],
      velocityMin[0],
      velocityMin[1],
    );
    gl.uniform2f(
      this.drawLocs["u_velocity_max"],
      velocityMax[0],
      velocityMax[1],
    );
    if (geoBounds) {
      gl.uniform4f(
        this.drawLocs["u_geo_bounds"],
        geoBounds.west,
        geoBounds.south,
        geoBounds.east,
        geoBounds.north,
      );
    }

    gl.uniform1f(
      this.drawLocs["u_particles_res"],
      this.particleStateRes,
    );
    gl.uniform1f(this.drawLocs["u_world_size"], worldSize);
    gl.uniform1f(this.drawLocs["u_point_size"], this.params.pointSize);

    bindTexture(gl, this.colorRampTexture, 2);
    gl.uniform1i(this.drawLocs["u_color_ramp"], 2);

    gl.uniformMatrix4fv(
      this.drawLocs["u_matrix"],
      false,
      matrix instanceof Float32Array ? matrix : new Float32Array(Array.from(matrix)),
    );

    // Draw particles as points
    const aIndex = gl.getAttribLocation(this.drawProgram, "a_index");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleIndexBuffer);
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribPointer(aIndex, 1, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.POINTS, 0, this.numParticles);
    gl.disableVertexAttribArray(aIndex);

    // Debug: check if anything was drawn to screen FBO
    if (!(this as any)._debugDone) {
      (this as any)._debugDone = true;
      // Read a few pixels from screen FBO (we're still bound to it)
      const px = new Uint8Array(4);
      gl.readPixels(
        Math.floor(this.screenWidth / 2),
        Math.floor(this.screenHeight / 2),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px,
      );
      console.log("[zartigl] screen FBO center pixel after draw:", px);

      // Read particle state to verify positions
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.particleFramebuffers[1]);
      const statePx = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, statePx);
      const posX = (statePx[0] + statePx[1] / 256);
      const posY = (statePx[2] + statePx[3] / 256);
      console.log("[zartigl] particle 0 state RGBA:", statePx,
        "=> mercator pos:", posX.toFixed(4), posY.toFixed(4));

      // Rebind screen FBO for the blit step
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.screenFramebuffers[1]);
    }

    gl.disable(gl.BLEND);

    // --- 4. Display: blit screen texture to MapLibre's framebuffer ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, mapFramebuffer);
    gl.viewport(0, 0, this.screenWidth, this.screenHeight);

    gl.useProgram(this.fadeProgram);
    bindTexture(gl, this.screenTextures[1], 0);
    gl.uniform1i(this.fadeLocs["u_screen"], 0);
    gl.uniform1f(this.fadeLocs["u_opacity"], 1.0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.drawQuad();
    gl.disable(gl.BLEND);

    // --- 5. Swap ping-pong buffers ---
    this.particleStateTextures.reverse();
    this.particleFramebuffers.reverse();
    this.screenTextures.reverse();
    this.screenFramebuffers.reverse();
  }

  private drawQuad(): void {
    const gl = this.gl;
    const aPos = gl.getAttribLocation(
      gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram,
      "a_position",
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(aPos);
  }

  setSpeedFactor(v: number): void {
    this.params.speedFactor = v;
  }

  setFadeOpacity(v: number): void {
    this.params.fadeOpacity = v;
  }

  setDropRate(v: number): void {
    this.params.dropRate = v;
  }

  setDropRateBump(v: number): void {
    this.params.dropRateBump = v;
  }

  setPointSize(v: number): void {
    this.params.pointSize = v;
  }

  setParticleCount(count: number): void {
    this.params.particleCount = count;

    // Clean up old particle state
    const gl = this.gl;
    for (const t of this.particleStateTextures) gl.deleteTexture(t);
    for (const f of this.particleFramebuffers) gl.deleteFramebuffer(f);
    gl.deleteBuffer(this.particleIndexBuffer);

    // Re-create with new count
    this.initParticleState();

    // Clear screen textures to avoid stale trails
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.screenFramebuffers[i]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setColorRamp(ramp: Record<number, string>): void {
    const gl = this.gl;
    gl.deleteTexture(this.colorRampTexture);
    this.colorRampTexture = createColorRampTexture(gl, ramp);
    this.params.colorRamp = ramp;
  }

  /**
   * Reset all particles to random positions. Call after time/depth change.
   */
  resetParticles(): void {
    const gl = this.gl;
    const stateData = new Uint8Array(this.numParticles * 4);
    for (let i = 0; i < stateData.length; i++) {
      stateData[i] = Math.floor(Math.random() * 256);
    }

    for (const tex of this.particleStateTextures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.particleStateRes,
        this.particleStateRes,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        stateData,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Clear screen textures
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.screenFramebuffers[i]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.updateProgram);
    gl.deleteProgram(this.drawProgram);
    gl.deleteProgram(this.fadeProgram);
    for (const t of this.particleStateTextures) gl.deleteTexture(t);
    for (const f of this.particleFramebuffers) gl.deleteFramebuffer(f);
    if (this.screenTextures) {
      for (const t of this.screenTextures) gl.deleteTexture(t);
      for (const f of this.screenFramebuffers) gl.deleteFramebuffer(f);
    }
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.particleIndexBuffer);
    gl.deleteTexture(this.colorRampTexture);
  }
}
