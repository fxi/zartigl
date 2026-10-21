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
const { findLayer, layerPalettes, loadChunks } = await import("./layers");
const { COLOR_GRADE_OFF, COLOR_GRADE_VIBRANT } = await import("../engine");

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
const windDensity = (await import("../catalog")).requireCatalogEntry(WIND)
  .defaults.particles?.density;
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
        style: { palette: "viridis" },
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
      tint: "",
      style: { palette: "viridis" },
    });
    expect(p.palette).toBe("viridis");
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

  it("applies a view style over the layer's, and drops it with the next view", async () => {
    const p = new Projversor(canvases());
    const particles = () =>
      (p as unknown as { particleSettings: { density: number; speed: number } })
        .particleSettings;
    const opened = p.apply(
      { layer: "surface-wind", style: { particles: { density: 0.12 } } },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    expect(particles().density).toBe(0.12);
    // Same layer: restyled in place, other keys back to the layer's own.
    await p.apply(
      { layer: "surface-wind", style: { particles: { speed: 3 } } },
      { animate: false },
    );
    expect(particles()).toMatchObject({ density: windDensity, speed: 3 });
    await p.apply({ layer: "surface-wind", style: {} }, { animate: false });
    expect(particles()).toMatchObject({ density: windDensity, speed: 1 });
    // No style: the current one stays, as for share links and the UI.
    await p.apply({ layer: "surface-wind" }, { animate: false });
    expect(particles().speed).toBe(1);
  });

  it("styles a layer opening in the background with its own view style", async () => {
    const p = new Projversor(canvases());
    const density = () =>
      (p as unknown as { particleSettings: { density: number } })
        .particleSettings.density;
    const opened = p.apply(
      { layer: "surface-wind", style: { particles: { density: 0.12 } } },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    const currents = p.apply(
      {
        layer: "ocean-current-velocity",
        style: { particles: { density: 0.02 } },
      },
      { animate: false },
    );
    await flush();
    // The shown layer is restyled meanwhile.
    await p.apply(
      { layer: "surface-wind", style: { particles: { density: 0.15 } } },
      { animate: false },
    );
    expect(density()).toBe(0.15);
    resolveMonth(CURRENTS, "feb");
    await currents;
    expect(p.layer.id).toBe("ocean-current-velocity");
    expect(density()).toBe(0.02);
  });

  it("takes the grade from the view style, tuned or not", async () => {
    const p = new Projversor(canvases());
    const opened = p.apply(
      { layer: "surface-wind", style: { particles: { grade: "vibrant" } } },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    expect(p.grade).toEqual(COLOR_GRADE_VIBRANT);
    await p.apply({ layer: "surface-wind", style: {} }, { animate: false });
    expect(p.grade).toEqual(COLOR_GRADE_OFF);
    const tuned = { ...COLOR_GRADE_VIBRANT, saturation: 0.9 };
    await p.apply(
      {
        layer: "surface-wind",
        style: { particles: { grade: { saturation: 0.9 } } },
      },
      { animate: false },
    );
    expect(p.grade).toEqual(tuned);
    // Without a style, a tuned grade stays.
    await p.apply({ layer: "surface-wind" }, { animate: false });
    expect(p.grade).toEqual(tuned);
  });

  it("keeps the winning grade when a superseded load ends", async () => {
    const p = new Projversor(canvases());
    const first = p.apply(
      { layer: "surface-wind", grade: COLOR_GRADE_VIBRANT },
      { animate: false },
    );
    await flush();
    const second = p.apply(
      { layer: "ocean-current-velocity", grade: COLOR_GRADE_OFF },
      { animate: false },
    );
    await flush();
    resolveMonth(CURRENTS, "feb");
    await second;
    resolveMonth(WIND, "feb");
    await first;
    expect(p.layer.id).toBe("ocean-current-velocity");
    expect(p.grade).toEqual(COLOR_GRADE_OFF);
  });

  it("takes the palette from the view style, and resets it with the next", async () => {
    const p = new Projversor(canvases());
    const wind = findLayer("surface-wind")!;
    const other = layerPalettes(wind).find(
      (e) => e.id !== wind.style.palette,
    )!.id;
    const opened = p.apply(
      { layer: "surface-wind", style: { palette: other } },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    expect(p.palette).toBe(other);
    await p.apply({ layer: "surface-wind", style: {} }, { animate: false });
    expect(p.palette).toBe(wind.style.palette);
  });

  it("draws the grade a layer's own style sets", async () => {
    const p = new Projversor(canvases());
    const wind = findLayer("surface-wind")!;
    const opened = p.open({
      ...wind,
      style: { ...wind.style, particles: { grade: "vibrant" } },
    });
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    expect(p.grade).toEqual(COLOR_GRADE_VIBRANT);
    // The next layer draws its own grade.
    const next = p.open("ocean-current-velocity");
    await flush();
    resolveMonth(CURRENTS, "feb");
    await next;
    expect(p.grade).toEqual(COLOR_GRADE_OFF);
  });

  it("keeps palette and grade picks in the shared style", async () => {
    const p = new Projversor(canvases());
    const opened = p.apply({ layer: "surface-wind" }, { animate: false });
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    p.setPalette("viridis");
    p.setGrade({ ...COLOR_GRADE_VIBRANT, contrast: 0.2 });
    expect(p.palette).toBe("viridis");
    expect(p.grade).toMatchObject({ enabled: true, contrast: 0.2 });
    expect(p.getState().style).toEqual({
      palette: "viridis",
      particles: {
        grade: {
          exposure: 0.8,
          contrast: 0.2,
          saturation: 0.4,
          highlights: 0.6,
        },
      },
    });
  });

  it("moves a deprecated flat palette and grade to the style", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = new Projversor(canvases());
    const opened = p.apply(
      { layer: "surface-wind", palette: "viridis", grade: COLOR_GRADE_VIBRANT },
      { animate: false },
    );
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    expect(p.palette).toBe("viridis");
    expect(p.grade).toEqual(COLOR_GRADE_VIBRANT);
    expect(p.getState().style).toEqual({
      palette: "viridis",
      particles: { grade: "vibrant" },
    });
    warn.mockRestore();
  });

  it("validates a style against what it renders for the layer", async () => {
    const p = new Projversor(canvases());
    await expect(
      p.apply({
        layer: "sea-ice-thickness",
        style: { particles: { density: 0.1 } },
      }),
    ).rejects.toThrow("style.particles needs a vector layer");
    await expect(
      p.open("surface-wind", { style: { renderMode: "raster" } }),
    ).rejects.toThrow("style.renderMode is not supported here");
  });

  it("redraws settled particles when restyled", async () => {
    const p = new Projversor(canvases());
    const opened = p.apply({ layer: "surface-wind" }, { animate: false });
    await flush();
    resolveMonth(WIND, "feb");
    await opened;
    const internal = p as unknown as { settle: number };
    internal.settle = 0;
    await p.apply(
      { layer: "surface-wind", style: { particles: { fade: 0.9 } } },
      { animate: false },
    );
    expect(internal.settle).toBeGreaterThan(0);
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
