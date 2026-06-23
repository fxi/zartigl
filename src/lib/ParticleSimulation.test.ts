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
    internals.stateFormat = { float: true, internalFormat: 0x1908, type: 0x1406 };
    const data = internals.makeStateData();

    expect(data).toBeInstanceOf(Float32Array);
    expect(data.length).toBe(512 * 512 * 4);
  });

  it("initializes RGBA8-packed particle state as bytes", () => {
    const simulation = new ParticleSimulation({ particleState: "rgba8" });
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = { float: false, internalFormat: 0x1908, type: 0x1401 };
    const data = internals.makeStateData();

    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(512 * 512 * 4);
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

  it("suppresses RGBA8 particles only above the configured max zoom", () => {
    const simulation = new ParticleSimulation({ particleState: "rgba8", rgba8MaxParticleZoom: 4 });
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = { float: false, internalFormat: 0x1908, type: 0x1401 };

    expect(internals.shouldSuppressRgba8Particles(512 * 2 ** 4)).toBe(false);
    expect(internals.shouldSuppressRgba8Particles(512 * 2 ** 5)).toBe(true);
  });

  it("does not zoom-limit float particles", () => {
    const simulation = new ParticleSimulation({ rgba8MaxParticleZoom: 4 });
    const internals = simulation as unknown as StateInternals;
    internals.stateFormat = { float: true, internalFormat: 0x1908, type: 0x1406 };

    expect(internals.shouldSuppressRgba8Particles(512 * 2 ** 12)).toBe(false);
  });
});
