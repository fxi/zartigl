import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A promise resolved from the outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const manifests = new Map<string, ReturnType<typeof deferred<unknown>>>();
const manifestFor = (url: string) => {
  if (!manifests.has(url)) {
    manifests.set(url, deferred<unknown>());
  }
  return manifests.get(url)!;
};

vi.mock("../engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engine")>()),
  loadGeoVideoManifest: vi.fn((url: string) => manifestFor(url).promise),
  createColorRampTexture: vi.fn(() => ({})),
}));

vi.mock("./layers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./layers")>()),
  loadChunks: vi.fn(async (entryId: string) => [
    {
      manifestUrl: `${entryId}/jan`,
      temporal: {
        mode: "fixed",
        start: "2025-01-01T00:00:00Z",
        end: "2025-01-31T00:00:00Z",
      },
    },
    {
      manifestUrl: `${entryId}/feb`,
      temporal: {
        mode: "fixed",
        start: "2025-02-01T00:00:00Z",
        end: "2025-02-28T00:00:00Z",
      },
    },
  ]),
  loadTintChunks: vi.fn(async () => []),
}));

const destroyed: string[] = [];

vi.mock("./GeoVideoField", () => ({
  GeoVideoField: class {
    readonly times: number[];
    readonly bounds = [-180, -90, 180, 90] as const;
    readonly vector = true;
    constructor(
      _gl: unknown,
      readonly manifest: { url: string; times: number[] },
    ) {
      this.times = manifest.times;
    }
    async prime(): Promise<void> {}
    focus(): void {}
    destroy(): void {
      destroyed.push(this.manifest.url);
    }
  },
}));

vi.mock("./Overlay", () => ({
  Overlay: class {
    fillLand = true;
  },
}));

vi.mock("./SphereParticles", () => ({
  SphereParticles: class {
    resize(): void {}
    destroy(): void {}
  },
  visibleCap: () => 1,
}));

vi.mock("./SphereScalar", () => ({
  SphereScalar: class {
    destroy(): void {}
  },
}));

const { Projversor } = await import("./Projversor");
const { loadChunks } = await import("./layers");

function canvases() {
  const gl = { deleteTexture: vi.fn() };
  const canvas = () =>
    ({
      width: 0,
      height: 0,
      getContext: () => gl,
    }) as unknown as HTMLCanvasElement;
  return {
    stage: { clientWidth: 800, clientHeight: 600 } as HTMLElement,
    back: canvas(),
    gl: canvas(),
    front: canvas(),
  };
}

/** Month manifest of an entry, two daily frames in January or February. */
function resolveMonth(entryId: string, month: "jan" | "feb"): void {
  const start = Date.parse(`2025-${month === "jan" ? "01" : "02"}-01`);
  const url = `${entryId}/${month}`;
  manifestFor(url).resolve({ url, times: [start, start + 86_400_000] });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const WIND = "72aa3549-8cdf-4275-b8f7-5b32ca40a3f2";
const CURRENTS = "61a81ddd-6c8e-4020-a59f-06ef13a90419";

describe("Projversor", () => {
  beforeEach(() => {
    manifests.clear();
    destroyed.length = 0;
    vi.mocked(loadChunks).mockClear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies a shared state and reports it back", async () => {
    const p = new Projversor(canvases(), { preset: "north" });
    const time = Date.parse("2025-02-01T12:00:00Z");
    const applied = p.apply(
      {
        layer: "surface-wind",
        preset: "north",
        rotate: [10, -90, 0],
        zoom: 2,
        time,
        palette: "viridis",
        playing: false,
      },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "feb");
    await applied;
    expect(p.getState()).toMatchObject({
      layer: "surface-wind",
      preset: "north",
      zoom: 2,
      time,
      playing: false,
      palette: "viridis",
      tint: "",
    });
    expect(p.getState().rotate.map((v) => v + 0)).toEqual([10, -90, 0]);
    expect(p.chunkIndex).toBe(1);
  });

  it("keeps the shown layer's palette and speed until the next month is decoded", async () => {
    const p = new Projversor(canvases());
    const opened = p.apply(
      { layer: "surface-wind", palette: "viridis", speed: 1 },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    const next = p.apply(
      { layer: "ocean-current-velocity", palette: "thermal", speed: 5 },
      { animate: false },
    );
    // Index loaded, month still decoding: the shown view is untouched.
    await flush();
    expect(p.layer.id).toBe("surface-wind");
    expect(p.palette).toBe("viridis");
    expect(p.speed).toBe(1);
    resolveMonth(CURRENTS, "feb");
    await next;
    expect(p.layer.id).toBe("ocean-current-velocity");
    expect(p.palette).toBe("thermal");
    expect(p.speed).toBe(5);
  });

  it("applies the new speed before announcing the new layer", async () => {
    const p = new Projversor(canvases());
    const speeds: number[] = [];
    p.on("layer", () => speeds.push(p.speed));
    const opened = p.apply({ layer: "surface-wind", speed: 2 });
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    expect(speeds).toEqual([2]);
  });

  it("keeps the winning state when a superseded load ends", async () => {
    const p = new Projversor(canvases());
    const first = p.apply({ layer: "surface-wind", speed: 5 });
    await flush();
    const second = p.apply({ layer: "surface-wind", speed: 2 });
    await flush();
    resolveMonth(WIND, "feb");
    await Promise.all([first, second]);
    expect(p.speed).toBe(2);
  });

  it("ignores the failure of a superseded load", async () => {
    const p = new Projversor(canvases());
    const statuses: string[] = [];
    p.on("status", (text) => statuses.push(text));
    const first = p.open("surface-wind");
    await flush();
    const second = p.open("ocean-current-velocity");
    manifestFor(`${WIND}/feb`).reject(new Error("decode failed"));
    await expect(first).resolves.toBeUndefined();
    await flush();
    resolveMonth(CURRENTS, "feb");
    await second;
    expect(p.layer.id).toBe("ocean-current-velocity");
    expect(statuses[statuses.length - 1]).toBe("");
  });

  it("refuses a layer without archive months and keeps the shown one", async () => {
    const p = new Projversor(canvases());
    const opened = p.open("surface-wind");
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    vi.mocked(loadChunks).mockResolvedValueOnce([]);
    await expect(p.open("ocean-current-velocity")).rejects.toThrow(
      /no archive months/,
    );
    expect(p.layer.id).toBe("surface-wind");
  });

  it("drops a stale layer load and destroys its month", async () => {
    const p = new Projversor(canvases());
    const first = p.open("surface-wind");
    // The first load is decoding its month when the second one starts.
    await flush();
    const second = p.open("ocean-current-velocity");
    resolveMonth(WIND, "feb");
    await first;
    await flush();
    resolveMonth(CURRENTS, "feb");
    await second;
    expect(p.layer.id).toBe("ocean-current-velocity");
    expect(destroyed).toEqual([`${WIND}/feb`]);
  });

  it("only seeks when the layer and tint stay the same", async () => {
    const p = new Projversor(canvases());
    const opened = p.apply({ layer: "surface-wind" }, { animate: false });
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    const seek = p.apply(
      { layer: "surface-wind", time: Date.parse("2025-01-01T06:00:00Z") },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "jan");
    await seek;
    expect(loadChunks).toHaveBeenCalledTimes(1);
    expect(p.chunkIndex).toBe(0);
    expect(p.time).toBe(Date.parse("2025-01-01T06:00:00Z"));
  });

  it("refits the sphere to a free zone", () => {
    const p = new Projversor(canvases());
    p.jumpTo({ preset: "globe" });
    const full = p.getState();
    const inset = { top: 0, right: 0, bottom: 0, left: 400 };
    p.jumpTo({ inset });
    expect(p.inset).toEqual(inset);
    // The view itself (rotation, zoom) is unchanged; only the fit moves.
    expect(p.getState().zoom).toBe(full.zoom);
    p.setInset({ top: 0, right: 0, bottom: 0, left: 0 }, 500);
    expect(p.inset.left).toBe(0);
  });

  it("locks north up for a near-zero bearing", () => {
    const p = new Projversor(canvases());
    p.jumpTo({ preset: "globe", rotate: [0, 20, 0.2] });
    expect(p.northLocked).toBe(true);
    expect(p.rotate[2]).toBeCloseTo(0);
    p.jumpTo({ rotate: [0, 20, 30] });
    expect(p.northLocked).toBe(false);
  });
});
