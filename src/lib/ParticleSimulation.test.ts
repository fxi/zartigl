import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticleSimulation } from "./ParticleSimulation";

type TransitionInternals = {
  updateTrailFadeOpacity(now: number): number;
};

type StateInternals = {
  makeStateData(): Uint8Array;
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

  it("initializes particle state as RGBA8-packed bytes", () => {
    const simulation = new ParticleSimulation();
    const data = (simulation as unknown as StateInternals).makeStateData();

    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(512 * 512 * 4);
  });

  it("reports RGBA8-packed particle state in debug info", () => {
    const simulation = new ParticleSimulation();

    expect(simulation.getDebugInfo()).toMatchObject({
      particleState: "rgba8-packed",
      particleStateResolution: 512,
      maxParticles: 512 * 512,
    });
  });
});
