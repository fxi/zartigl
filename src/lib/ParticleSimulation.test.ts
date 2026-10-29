import { geoVideoTestGl } from "./test-geovideo";
import type { VelocityTexturePair } from "./velocity-pair";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticleSimulation } from "./ParticleSimulation";
import type { StateTextureFormat } from "./gl-util";

type TransitionInternals = {
  updateTrailFadeOpacity(now: number): number;
};

type StateInternals = {
  stateFormat: StateTextureFormat;
  makeStateData(): ArrayBufferView;
  shouldSuppressRgba8Particles(worldSize: number): boolean;
};

describe("ParticleSimulation camera trail fade", () => {
  afterEach(() => vi.restoreAllMocks());

  it("smoothly lowers retention during movement and restores it afterward", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1_000);
    const simulation = new ParticleSimulation({ fadeOpacity: 0.99 });
    const transition = simulation as unknown as TransitionInternals;

    simulation.setCameraMoving(true);
    expect(transition.updateTrailFadeOpacity(1_000)).toBeCloseTo(0.99);
    expect(transition.updateTrailFadeOpacity(1_060)).toBeCloseTo(0.895);
    expect(transition.updateTrailFadeOpacity(1_120)).toBeCloseTo(0.8);

    now.mockReturnValue(1_120);
    simulation.setCameraMoving(false);
    expect(transition.updateTrailFadeOpacity(1_270)).toBeCloseTo(0.895);
    expect(transition.updateTrailFadeOpacity(1_420)).toBeCloseTo(0.99);
  });

  it("restores a fade setting changed during movement", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(2_000);
    const simulation = new ParticleSimulation({ fadeOpacity: 0.99 });
    const transition = simulation as unknown as TransitionInternals;

    simulation.setCameraMoving(true);
    simulation.setFadeOpacity(0.97);
    transition.updateTrailFadeOpacity(2_120);

    now.mockReturnValue(2_120);
    simulation.setCameraMoving(false);
    expect(transition.updateTrailFadeOpacity(2_420)).toBeCloseTo(0.97);
  });

  it("initializes float particle state as Float32 data", () => {
    const simulation = new ParticleSimulation();
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = {
      kind: "float32",
      internalFormat: 0x1908,
      type: 0x1406,
    };
    const data = internals.makeStateData();

    expect(data).toBeInstanceOf(Float32Array);
    expect((data as Float32Array).length).toBe(512 * 512 * 4);
  });

  it("initializes half-float particle state as half-float words", () => {
    const simulation = new ParticleSimulation();
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = {
      kind: "float16",
      internalFormat: 0x1908,
      type: 0x8d61,
    };
    const data = internals.makeStateData();

    expect(data).toBeInstanceOf(Uint16Array);
    expect((data as Uint16Array).length).toBe(512 * 512 * 4);
  });

  it("initializes RGBA8-packed particle state as bytes", () => {
    const simulation = new ParticleSimulation({ particleState: "rgba8" });
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = {
      kind: "rgba8-packed",
      internalFormat: 0x1908,
      type: 0x1401,
    };
    const data = internals.makeStateData();

    expect(data).toBeInstanceOf(Uint8Array);
    expect((data as Uint8Array).length).toBe(512 * 512 * 4);
  });

  it("reports requested and active particle state in debug info", () => {
    const simulation = new ParticleSimulation({ particleState: "rgba8" });

    expect(simulation.getDebugInfo()).toMatchObject({
      particleState: "rgba8-packed",
      particleStateMode: "rgba8",
      particleStateResolution: 512,
      maxParticles: 512 * 512,
      rgba8MaxParticleZoom: 4,
      rgba8ParticlesSuppressed: false,
    });
  });

  it("keeps the glow off by default and clamps it to [0, 1]", () => {
    const simulation = new ParticleSimulation();
    expect(simulation.getDebugInfo().glow).toBe(0);
    simulation.setGlow(2);
    expect(simulation.getDebugInfo().glow).toBe(1);
    simulation.setGlow(-1);
    expect(simulation.getDebugInfo().glow).toBe(0);
  });

  it("suppresses RGBA8 particles only above the configured max zoom", () => {
    const simulation = new ParticleSimulation({
      particleState: "rgba8",
      rgba8MaxParticleZoom: 4,
    });
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = {
      kind: "rgba8-packed",
      internalFormat: 0x1908,
      type: 0x1401,
    };

    expect(internals.shouldSuppressRgba8Particles(512 * 2 ** 4)).toBe(false);
    expect(internals.shouldSuppressRgba8Particles(512 * 2 ** 5)).toBe(true);
  });

  it("does not zoom-limit float particles", () => {
    const simulation = new ParticleSimulation({ rgba8MaxParticleZoom: 4 });
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = {
      kind: "float16",
      internalFormat: 0x1908,
      type: 0x8d61,
    };

    expect(internals.shouldSuppressRgba8Particles(512 * 2 ** 12)).toBe(false);
  });
});

describe("ParticleSimulation velocity pairs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup() {
    const { gl, calls } = geoVideoTestGl();
    const simulation = new ParticleSimulation();
    // Test the render passes with already-allocated GPU resources.
    const locations = (pass: string) =>
      new Proxy({}, { get: (_target, name) => `${pass}:${String(name)}` });
    Object.assign(simulation, {
      gl,
      screenWidth: 800,
      screenHeight: 600,
      updateLocs: locations("update"),
      drawLocs: locations("draw"),
      gridLocs: locations("grid"),
      gridGlobeLocs: locations("globe"),
      fadeLocs: locations("fade"),
      compositeLocs: locations("composite"),
      particleStateTextures: [{}, {}],
      particleFramebuffers: [{}, {}],
      screenTextures: [{}, {}],
      screenFramebuffers: [{}, {}],
    });
    const render = (pair?: VelocityTexturePair, globe = false) =>
      simulation.render(
        1,
        [-2, -3],
        [2, 3],
        new Float32Array(16),
        { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        512,
        [0],
        { west: -180, south: -90, east: 180, north: 90 },
        globe,
        [0, 0, 1],
        [0, 0, 1, 0],
        pair,
      );
    return { calls, render };
  }

  it.each([false, true])(
    "sends the same mix to advection, speed color and raster (globe=%s)",
    (globe) => {
      const { calls, render } = setup();
      render(
        {
          a: {
            unit: 1,
            min: [-2, -3],
            max: [2, 3],
            physical: true,
            northToSouth: true,
          },
          b: {
            unit: 4,
            min: [-5, -6],
            max: [5, 6],
            physical: true,
            northToSouth: true,
          },
          mix: 0.375,
        },
        globe,
      );
      for (const pass of ["update", "draw", globe ? "globe" : "grid"]) {
        expect(calls.uniform1f).toHaveBeenCalledWith(
          `${pass}:u_velocity_mix`,
          0.375,
        );
        expect(calls.uniform1f).toHaveBeenCalledWith(
          `${pass}:u_velocity_physical`,
          1,
        );
        expect(calls.uniform1f).toHaveBeenCalledWith(
          `${pass}:u_velocity_next_flip_y`,
          1,
        );
        expect(calls.uniform1i).toHaveBeenCalledWith(
          `${pass}:u_velocity_next`,
          4,
        );
        expect(calls.uniform2f).toHaveBeenCalledWith(
          `${pass}:u_velocity_next_min`,
          -5,
          -6,
        );
        expect(calls.uniform2f).toHaveBeenCalledWith(
          `${pass}:u_velocity_next_max`,
          5,
          6,
        );
      }
    },
  );

  it("keeps Zarr single-field sampling, decoding and row order", () => {
    const { calls, render } = setup();
    render();
    for (const pass of ["update", "draw", "grid"]) {
      expect(calls.uniform1f).toHaveBeenCalledWith(`${pass}:u_velocity_mix`, 0);
      expect(calls.uniform1f).toHaveBeenCalledWith(
        `${pass}:u_velocity_physical`,
        0,
      );
      expect(calls.uniform1f).toHaveBeenCalledWith(
        `${pass}:u_velocity_flip_y`,
        0,
      );
      expect(calls.uniform1i).toHaveBeenCalledWith(
        `${pass}:u_velocity_next`,
        1,
      );
    }
  });
});
