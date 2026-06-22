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
    resize: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
  }> = [];

  const fieldInstances: Array<{
    init: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setFilter: ReturnType<typeof vi.fn>;
    hasData: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
    geoBounds: { west: number; south: number; east: number; north: number };
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
      resize: vi.fn(),
      render: vi.fn(),
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
      setFilter: vi.fn(),
      hasData: vi.fn(() => true),
      bind: vi.fn(),
      uMin: -1,
      uMax: 1,
      vMin: -2,
      vMax: 2,
      geoBounds: { west: -180, south: -80, east: 180, north: 80 },
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

  getProjection(): { type: string } {
    return { type: "globe" };
  }

  getBounds() {
    return {
      getWest: () => -180,
      getEast: () => 180,
      getSouth: () => -80,
      getNorth: () => 80,
    };
  }

  getZoom(): number {
    return 2;
  }

  getCenter(): { lng: number; lat: number } {
    return { lng: 0, lat: 0 };
  }
}

function createLayer(renderMode?: "particles" | "raster" | "raster+particles"): VectorLayer {
  return new VectorLayer({
    id: "particles",
    source: "https://example.test/current.zarr",
    renderMode,
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

  it("uses the configured render mode and updates sampling when it changes", () => {
    const layer = createLayer("raster+particles");
    const simulation = mocks.simulationInstances[0];
    const field = mocks.fieldInstances[0];

    expect(simulation.setRenderMode).toHaveBeenCalledWith("raster+particles");
    expect(field.setFilter).toHaveBeenCalledWith(true);

    layer.setRenderMode("raster");
    expect(simulation.setRenderMode).toHaveBeenLastCalledWith("raster");
    expect(field.setFilter).toHaveBeenLastCalledWith(false);

    layer.setRenderMode("particles");
    expect(field.setFilter).toHaveBeenLastCalledWith(true);
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

  it("forwards globe projection and clipping data to the simulation", async () => {
    const map = new FakeMap();
    const layer = createLayer("raster");
    await layer.onAdd(map as never, {} as never);
    (layer as unknown as { initialized: boolean }).initialized = true;

    const gl = {
      canvas: { width: 800, height: 600 },
      getParameter: vi.fn((key) => key === 10 ? new Int32Array([0, 0, 800, 600]) : 0),
      isEnabled: vi.fn(() => false),
      useProgram: vi.fn(),
      activeTexture: vi.fn(),
      bindBuffer: vi.fn(),
      bindFramebuffer: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      viewport: vi.fn(),
      blendFunc: vi.fn(),
      CURRENT_PROGRAM: 1,
      ACTIVE_TEXTURE: 2,
      ARRAY_BUFFER_BINDING: 3,
      ELEMENT_ARRAY_BUFFER_BINDING: 4,
      FRAMEBUFFER_BINDING: 5,
      BLEND: 6,
      DEPTH_TEST: 7,
      STENCIL_TEST: 8,
      BLEND_SRC_RGB: 9,
      VIEWPORT: 10,
      BLEND_DST_RGB: 11,
      ARRAY_BUFFER: 12,
      ELEMENT_ARRAY_BUFFER: 13,
      FRAMEBUFFER: 14,
    };
    const clippingPlane: [number, number, number, number] = [0, 0, 1, 0];
    const matrix = new Float32Array(16);

    layer.render(gl as never, {
      modelViewProjectionMatrix: matrix,
      defaultProjectionData: { clippingPlane },
    } as never);

    expect(mocks.simulationInstances[0].render).toHaveBeenCalledWith(
      1,
      [-1, -2],
      [1, 2],
      matrix,
      expect.any(Object),
      2048,
      [0],
      { west: -180, south: -80, east: 180, north: 80 },
      true,
      [0, 0, 1],
      clippingPlane,
    );
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
