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
import gridFrag from "./shaders/grid.frag.glsl?raw";

export type RenderMode = 'raster' | 'particles' | 'raster+particles';

/**
 * State texture is always allocated at this fixed resolution.
 * MAX_PARTICLES = 512 * 512 = 262144.
 * The active draw count varies with canvas size and density — no reallocation.
 */
const MAX_PARTICLE_STATE_RES = 512;
const MAX_PARTICLES = MAX_PARTICLE_STATE_RES * MAX_PARTICLE_STATE_RES;

export interface SimulationParams {
  /** Particles per screen pixel. Active count = clamp(w * h * density, 1, MAX). */
  particleDensity: number;
  speedFactor: number;
  fadeOpacity: number;
  dropRate: number;
  dropRateBump: number;
  colorRamp?: Record<number, string>;
  opacity: number;
  logScale: boolean;
  vibrance: number;
}

const DEFAULTS: SimulationParams = {
  particleDensity: 0.05,
  speedFactor: 0.25,
  fadeOpacity: 0.996,
  dropRate: 0.003,
  dropRateBump: 0.01,
  opacity: 1.0,
  logScale: false,
  vibrance: 0.0,
};

export class ParticleSimulation {
  private gl!: WebGLRenderingContext;
  private params: SimulationParams;

  // Programs
  private updateProgram!: WebGLProgram;
  private drawProgram!: WebGLProgram;
  private fadeProgram!: WebGLProgram;
  private gridProgram!: WebGLProgram;

  // Particle state ping-pong — fixed MAX size, never reallocated
  private particleStateTextures!: [WebGLTexture, WebGLTexture];
  private particleFramebuffers!: [WebGLFramebuffer, WebGLFramebuffer];
  private particleIndexBuffer!: WebGLBuffer;
  private particleIsCurrBuffer!: WebGLBuffer;

  /** Active draw count — changes with canvas size / density, no realloc. */
  private numParticles = 0;

  // Screen textures for trail rendering
  private screenTextures!: [WebGLTexture, WebGLTexture];
  private screenFramebuffers!: [WebGLFramebuffer, WebGLFramebuffer];
  private screenWidth = 0;
  private screenHeight = 0;

  // Shared geometry
  private quadBuffer!: WebGLBuffer;
  private colorRampTexture!: WebGLTexture;

  // Render mode
  renderMode: RenderMode = 'raster+particles';

  // Uniform locations (cached)
  private updateLocs!: Record<string, WebGLUniformLocation | null>;
  private drawLocs!: Record<string, WebGLUniformLocation | null>;
  private fadeLocs!: Record<string, WebGLUniformLocation | null>;
  private gridLocs!: Record<string, WebGLUniformLocation | null>;

  constructor(params?: Partial<SimulationParams>) {
    this.params = { ...DEFAULTS, ...params };
  }

  init(gl: WebGLRenderingContext): void {
    this.gl = gl;

    // Compile programs
    this.updateProgram = createProgram(gl, quadVert, updateFrag);
    this.drawProgram = createProgram(gl, drawVert, drawFrag);
    this.fadeProgram = createProgram(gl, quadVert, fadeFrag);
    this.gridProgram = createProgram(gl, quadVert, gridFrag);

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
      "u_world_offset",
      "u_speed_factor",
      "u_color_ramp",
      "u_geo_bounds",
      "u_particle_color",
      "u_opacity",
      "u_log_scale",
      "u_vibrance",
    ]);
    this.fadeLocs = this.getUniforms(this.fadeProgram, [
      "u_screen",
      "u_opacity",
    ]);
    this.gridLocs = this.getUniforms(this.gridProgram, [
      "u_field",
      "u_color_ramp",
      "u_bounds",
      "u_geo_bounds",
      "u_field_min",
      "u_field_max",
      "u_u_min",
      "u_u_max",
      "u_v_min",
      "u_v_max",
      "u_opacity",
      "u_log_scale",
      "u_vibrance",
    ]);


    // Shared resources
    this.quadBuffer = createQuadBuffer(gl);
    this.colorRampTexture = createColorRampTexture(gl, this.params.colorRamp);

    // Allocate particle state at MAX size — never reallocated after this
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
    const res = MAX_PARTICLE_STATE_RES;

    // Random initial positions across the full texture
    const stateData = new Uint8Array(res * res * 4);
    for (let i = 0; i < stateData.length; i++) {
      stateData[i] = Math.floor(Math.random() * 256);
    }

    const tex0 = createTexture(gl, gl.NEAREST, stateData, res, res);
    const tex1 = createTexture(gl, gl.NEAREST, stateData, res, res);
    const fb0 = createFramebuffer(gl, tex0);
    const fb1 = createFramebuffer(gl, tex1);

    this.particleStateTextures = [tex0, tex1];
    this.particleFramebuffers = [fb0, fb1];

    // Index + isCurr buffers at max capacity — draw call uses only numParticles * 2
    const indices = new Float32Array(MAX_PARTICLES * 2);
    const isCurr = new Float32Array(MAX_PARTICLES * 2);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      indices[i * 2]     = i;
      indices[i * 2 + 1] = i;
      isCurr[i * 2]      = 0.0;
      isCurr[i * 2 + 1]  = 1.0;
    }

    this.particleIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleIndexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    this.particleIsCurrBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleIsCurrBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, isCurr, gl.STATIC_DRAW);
  }

  /**
   * Ensure screen textures match the current canvas size and recompute
   * the active particle count from density × canvas area.
   */
  resize(width: number, height: number): void {
    // Always recompute active count — density or canvas size may have changed
    this.numParticles = Math.max(
      1,
      Math.min(MAX_PARTICLES, Math.round(width * height * this.params.particleDensity)),
    );

    if (width === this.screenWidth && height === this.screenHeight) return;

    const gl = this.gl;
    this.screenWidth = width;
    this.screenHeight = height;

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
    worldCopyOffsets: number[],
    geoBounds?: { west: number; south: number; east: number; north: number },
  ): void {
    const gl = this.gl;

    if (this.screenWidth === 0 || this.screenHeight === 0) return;

    // Capture MapLibre's current framebuffer so we can restore it for the final blit
    const mapFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

    const runParticles = this.renderMode === 'particles' || this.renderMode === 'raster+particles';
    const runGrid = this.renderMode === 'raster' || this.renderMode === 'raster+particles';

    // --- 1. Update pass: advance particle positions (always — keeps simulation live) ---
    // Blending MUST be off: the alpha channel encodes position data (lo byte of Y),
    // not transparency. If blend leaks in, particles snap to 1/255 grid lines.
    gl.disable(gl.BLEND);
    gl.useProgram(this.updateProgram);
    gl.viewport(0, 0, MAX_PARTICLE_STATE_RES, MAX_PARTICLE_STATE_RES);

    bindTexture(gl, this.particleStateTextures[0], 0);
    gl.uniform1i(this.updateLocs["u_particles"], 0);

    gl.uniform1i(this.updateLocs["u_velocity"], velocityTexUnit);
    gl.uniform2f(this.updateLocs["u_velocity_min"], velocityMin[0], velocityMin[1]);
    gl.uniform2f(this.updateLocs["u_velocity_max"], velocityMax[0], velocityMax[1]);
    gl.uniform1f(this.updateLocs["u_speed_factor"], this.params.speedFactor);
    gl.uniform1f(this.updateLocs["u_rand_seed"], Math.random());
    gl.uniform1f(this.updateLocs["u_drop_rate"], this.params.dropRate);
    gl.uniform1f(this.updateLocs["u_drop_rate_bump"], this.params.dropRateBump);
    gl.uniform4f(
      this.updateLocs["u_bounds"],
      bounds.minX, bounds.minY, bounds.maxX, bounds.maxY,
    );
    if (geoBounds) {
      gl.uniform4f(
        this.updateLocs["u_geo_bounds"],
        geoBounds.west, geoBounds.south, geoBounds.east, geoBounds.north,
      );
    }

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

    // --- 3. Grid pass: rasterize velocity field as a colormap overlay ---
    if (runGrid && geoBounds) {
      gl.useProgram(this.gridProgram);
      gl.disable(gl.BLEND);

      // velocity field texture is already bound to velocityTexUnit
      gl.uniform1i(this.gridLocs["u_field"], velocityTexUnit);

      bindTexture(gl, this.colorRampTexture, 2);
      gl.uniform1i(this.gridLocs["u_color_ramp"], 2);

      // u_bounds: mercator bounds in radians for the grid shader coordinate transform.
      // The grid shader uses the same u_bounds as the update shader (mercator [0,1] space),
      // but interprets it as radians — convert from [0,1] to radians here.
      const PI = Math.PI;
      const mercWest  = (bounds.minX * 2.0 - 1.0) * PI;
      const mercEast  = (bounds.maxX * 2.0 - 1.0) * PI;
      const mercSouth = (1.0 - bounds.maxY * 2.0) * PI;
      const mercNorth = (1.0 - bounds.minY * 2.0) * PI;
      gl.uniform4f(this.gridLocs["u_bounds"], mercWest, mercSouth, mercEast, mercNorth);

      gl.uniform4f(
        this.gridLocs["u_geo_bounds"],
        geoBounds.west, geoBounds.south, geoBounds.east, geoBounds.north,
      );

      // Speed range: 0 to max possible speed from the velocity components
      const maxSpeed = Math.sqrt(
        Math.max(Math.abs(velocityMin[0]), Math.abs(velocityMax[0])) ** 2 +
        Math.max(Math.abs(velocityMin[1]), Math.abs(velocityMax[1])) ** 2,
      );
      gl.uniform1f(this.gridLocs["u_field_min"], 0.0);
      gl.uniform1f(this.gridLocs["u_field_max"], maxSpeed > 0 ? maxSpeed : 1.0);

      gl.uniform1f(this.gridLocs["u_u_min"], velocityMin[0]);
      gl.uniform1f(this.gridLocs["u_u_max"], velocityMax[0]);
      gl.uniform1f(this.gridLocs["u_v_min"], velocityMin[1]);
      gl.uniform1f(this.gridLocs["u_v_max"], velocityMax[1]);

      gl.uniform1f(this.gridLocs["u_opacity"], this.params.opacity);
      gl.uniform1f(this.gridLocs["u_log_scale"], this.params.logScale ? 1.0 : 0.0);
      gl.uniform1f(this.gridLocs["u_vibrance"], this.params.vibrance);

      // Render grid blended on top of the faded trail screen buffer
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.drawQuad();
      gl.disable(gl.BLEND);

 
    }

    // --- 4. Draw pass: render particles on top of trails/grid ---
    if (runParticles) {
      gl.useProgram(this.drawProgram);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      bindTexture(gl, this.particleStateTextures[1], 0);
      gl.uniform1i(this.drawLocs["u_particles"], 0);

      gl.uniform1i(this.drawLocs["u_velocity"], velocityTexUnit);
      gl.uniform2f(this.drawLocs["u_velocity_min"], velocityMin[0], velocityMin[1]);
      gl.uniform2f(this.drawLocs["u_velocity_max"], velocityMax[0], velocityMax[1]);
      if (geoBounds) {
        gl.uniform4f(
          this.drawLocs["u_geo_bounds"],
          geoBounds.west, geoBounds.south, geoBounds.east, geoBounds.north,
        );
      }

      gl.uniform1f(this.drawLocs["u_particles_res"], MAX_PARTICLE_STATE_RES);
      gl.uniform1f(this.drawLocs["u_world_size"], worldSize);
      gl.uniform1f(this.drawLocs["u_speed_factor"], this.params.speedFactor);

      bindTexture(gl, this.colorRampTexture, 2);
      gl.uniform1i(this.drawLocs["u_color_ramp"], 2);

      // In raster+particles mode render particles white so they are visible over the colormap
      if (this.renderMode === 'raster+particles') {
        gl.uniform4f(this.drawLocs["u_particle_color"], 1.0, 1.0, 1.0, 1.0);
      } else {
        gl.uniform4f(this.drawLocs["u_particle_color"], 0.0, 0.0, 0.0, 0.0);
      }

      gl.uniform1f(this.drawLocs["u_opacity"], this.params.opacity);
      gl.uniform1f(this.drawLocs["u_log_scale"], this.params.logScale ? 1.0 : 0.0);
      gl.uniform1f(this.drawLocs["u_vibrance"], this.params.vibrance);

      gl.uniformMatrix4fv(
        this.drawLocs["u_matrix"],
        false,
        matrix instanceof Float32Array ? matrix : new Float32Array(Array.from(matrix)),
      );

      const aIndex = gl.getAttribLocation(this.drawProgram, "a_index");
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleIndexBuffer);
      gl.enableVertexAttribArray(aIndex);
      gl.vertexAttribPointer(aIndex, 1, gl.FLOAT, false, 0, 0);

      const aIsCurr = gl.getAttribLocation(this.drawProgram, "a_is_curr");
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleIsCurrBuffer);
      gl.enableVertexAttribArray(aIsCurr);
      gl.vertexAttribPointer(aIsCurr, 1, gl.FLOAT, false, 0, 0);

      // Draw active particles once per visible world copy
      for (const offset of worldCopyOffsets) {
        gl.uniform1f(this.drawLocs["u_world_offset"], offset);
        gl.drawArrays(gl.LINES, 0, this.numParticles * 2);
      }
      gl.disableVertexAttribArray(aIndex);
      gl.disableVertexAttribArray(aIsCurr);

      gl.disable(gl.BLEND);
    }

    // --- 5. Display: blit screen texture to MapLibre's framebuffer ---
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

    // --- 6. Swap ping-pong buffers ---
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

  setParticleDensity(density: number): void {
    this.params.particleDensity = density;
    // Recompute active count with current canvas dimensions
    this.numParticles = Math.max(
      1,
      Math.min(MAX_PARTICLES, Math.round(this.screenWidth * this.screenHeight * density)),
    );
  }

  setColorRamp(ramp: Record<number, string>): void {
    const gl = this.gl;
    gl.deleteTexture(this.colorRampTexture);
    this.colorRampTexture = createColorRampTexture(gl, ramp);
    this.params.colorRamp = ramp;
  }

  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
  }

  setOpacity(v: number): void {
    this.params.opacity = v;
  }

  setLogScale(v: boolean): void {
    this.params.logScale = v;
  }

  setVibrance(v: number): void {
    this.params.vibrance = v;
  }

  /**
   * Reset all particles to random positions. Call after time/depth change
   * or map move. Randomises the full state texture and clears trail FBOs.
   */
  resetParticles(): void {
    const gl = this.gl;
    const res = MAX_PARTICLE_STATE_RES;
    const stateData = new Uint8Array(res * res * 4);
    for (let i = 0; i < stateData.length; i++) {
      stateData[i] = Math.floor(Math.random() * 256);
    }

    for (const tex of this.particleStateTextures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, res, res, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, stateData,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.clearState();
  }

  /**
   * Clear screen framebuffers to transparent black.
   * Eliminates ghost trails when the viewport shifts.
   */
  clearState(): void {
    const gl = this.gl;
    if (!this.screenFramebuffers) return;
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
    gl.deleteProgram(this.gridProgram);
    for (const t of this.particleStateTextures) gl.deleteTexture(t);
    for (const f of this.particleFramebuffers) gl.deleteFramebuffer(f);
    if (this.screenTextures) {
      for (const t of this.screenTextures) gl.deleteTexture(t);
      for (const f of this.screenFramebuffers) gl.deleteFramebuffer(f);
    }
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.particleIndexBuffer);
    gl.deleteBuffer(this.particleIsCurrBuffer);
    gl.deleteTexture(this.colorRampTexture);
  }
}
