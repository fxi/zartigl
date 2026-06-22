import { beforeEach, describe, expect, it, vi } from "vitest";
import { VectorLayer } from "./VectorLayer";

const mocks = vi.hoisted(() => {
  const simulationInstances: Array<{
    init: ReturnType<typeof vi.fn>;
    clearState: ReturnType<typeof vi.fn>;
    resetParticles: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setRenderMode: ReturnType<typeof vi.fn>;
    setCameraMoving: ReturnType<typeof vi.fn>;
  }> = [];

  const fieldInstances: Array<{
    init: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];

  return {
    simulationInstances,
    fieldInstances,
    zarrCancelAll: vi.fn(),
  };
});

vi.mock("./ParticleSimulation", () => ({
  ParticleSimulation: vi.fn().mockImplementation(function () {
    const instance = {
      init: vi.fn(),
      clearState: vi.fn(),
      resetParticles: vi.fn(),
      destroy: vi.fn(),
      setRenderMode: vi.fn(),
      setCameraMoving: vi.fn(),
    };
    mocks.simulationInstances.push(instance);
    return instance;
  }),
}));

vi.mock("./VelocityField", () => ({
  VelocityField: vi.fn().mockImplementation(function () {
    const instance = {
      init: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.fieldInstances.push(instance);
    return instance;
  }),
  stitchVelocityChunks: vi.fn(),
}));

vi.mock("./ZarrSource", () => ({
  ZarrSource: vi.fn().mockImplementation(function () {
    return {
      cancelAll: mocks.zarrCancelAll,
    };
  }),
}));

const vectorLayerPrototype = VectorLayer.prototype as unknown as {
  initAsync(): Promise<void>;
  reloadIfViewportUncovered(): void;
};

class FakeMap {
  listeners = new Map<string, Set<() => void>>();
  triggerRepaint = vi.fn();

  on(event: string, handler: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: () => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event: string): void {
    this.listeners.get(event)?.forEach((handler) => handler());
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function createLayer(): VectorLayer {
  return new VectorLayer({
    id: "particles",
    source: "https://example.test/current.zarr",
  });
}

describe("VectorLayer camera particle state", () => {
  beforeEach(() => {
    mocks.simulationInstances.length = 0;
    mocks.fieldInstances.length = 0;
    mocks.zarrCancelAll.mockClear();
    vi.restoreAllMocks();
    vi.spyOn(vectorLayerPrototype, "initAsync").mockResolvedValue(undefined);
  });

  it("uses aggressive trail decay while the camera moves", async () => {
    const map = new FakeMap();
    const layer = createLayer();

    await layer.onAdd(map as never, {} as never);

    const simulation = mocks.simulationInstances[0];
    map.emit("movestart");
    map.emit("move");

    expect(simulation.setCameraMoving).toHaveBeenCalledOnce();
    expect(simulation.setCameraMoving).toHaveBeenCalledWith(true);
    expect(simulation.clearState).not.toHaveBeenCalled();
    expect(map.triggerRepaint).toHaveBeenCalledTimes(2);
  });

  it("keeps particle positions and checks viewport coverage when movement ends", async () => {
    const reloadSpy = vi
      .spyOn(vectorLayerPrototype, "reloadIfViewportUncovered")
      .mockImplementation(() => undefined);
    const map = new FakeMap();
    const layer = createLayer();

    await layer.onAdd(map as never, {} as never);

    const simulation = mocks.simulationInstances[0];
    map.emit("moveend");

    expect(simulation.setCameraMoving).toHaveBeenCalledWith(false);
    expect(simulation.resetParticles).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(map.triggerRepaint).toHaveBeenCalledOnce();
  });

  it("unregisters camera handlers on remove", async () => {
    const map = new FakeMap();
    const layer = createLayer();

    await layer.onAdd(map as never, {} as never);
    layer.onRemove();

    expect(map.listenerCount("movestart")).toBe(0);
    expect(map.listenerCount("move")).toBe(0);
    expect(map.listenerCount("moveend")).toBe(0);
  });
});
