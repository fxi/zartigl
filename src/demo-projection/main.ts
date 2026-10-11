import { easeCubicInOut } from "d3";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land110 from "world-atlas/land-110m.json";
import land50 from "world-atlas/land-50m.json";
import { requireCatalogEntry } from "../catalog";
import type { CatalogGeoVideoSource } from "../catalog/types";
import { loadGeoVideoManifest } from "../lib/geovideo";
import {
  geoVideoChunkSources,
  isGeoVideoArchiveSource,
  loadGeoVideoIndex,
} from "../lib/geovideo-index";
import { createColorRampTexture } from "../lib/gl-util";
import { CurrentField } from "./CurrentField";
import { DEMO_LAYERS, type DemoLayer } from "./layers";
import { Overlay } from "./Overlay";
import { ProjectedRaster } from "./ProjectedRaster";
import {
  PROJECTIONS,
  cartesian,
  fitScale,
  type ProjectionId,
} from "./projections";
import { SphereParticles, type ParticleStyle } from "./SphereParticles";
import {
  interpolateRotation,
  versor,
  versorDelta,
  versorMultiply,
  versorRotation,
} from "./versor";
import {
  dayTicks,
  formatUnit,
  legendTicks,
  particleBudget,
  particleSettings,
  rampGradient,
  rampPosition,
  type ParticleSettings,
} from "./scales";
import { viewFrame, type View } from "./view";

const STEPS_PER_SECOND = 1.5;
const TRANSITION_MS = 2200;
/** Fraction of a month after which the next one is decoded. */
const PREFETCH_AT = 0.6;

interface Upcoming {
  index: number;
  field: CurrentField | null;
}

interface Preset {
  id: string;
  label: string;
  projection: ProjectionId;
  rotate: [number, number, number];
  zoom: number;
}

const PRESETS: Preset[] = [
  {
    id: "south",
    label: "South Pole",
    projection: "azimuthalEquidistant",
    rotate: [0, 90, 0],
    zoom: 2.2,
  },
  {
    id: "north",
    label: "North Pole",
    projection: "azimuthalEqualArea",
    rotate: [0, -90, 0],
    zoom: 2.3,
  },
  {
    id: "globe",
    label: "Globe",
    projection: "orthographic",
    rotate: [-20, 25, 0],
    zoom: 1,
  },
  {
    id: "world",
    label: "Equal Earth",
    projection: "equalEarth",
    rotate: [-150, 0, 0],
    zoom: 1,
  },
  {
    id: "mollweide",
    label: "Mollweide",
    projection: "mollweide",
    rotate: [-20, 0, 0],
    zoom: 1,
  },
  {
    id: "plate",
    label: "Plate carrée",
    projection: "equirectangular",
    rotate: [0, 0, 0],
    zoom: 1,
  },
  {
    id: "lambert",
    label: "Equal-area",
    projection: "azimuthalEqualArea",
    rotate: [-160, 10, 0],
    zoom: 1.1,
  },
];

function refs(root: HTMLElement) {
  const get = <T extends HTMLElement>(name: string): T => {
    const el = root.querySelector<T>(`[data-ref="${name}"]`);
    if (!el) {
      throw new Error(`Missing element: ${name}`);
    }
    return el;
  };
  return {
    stage: get<HTMLElement>("stage"),
    back: get<HTMLCanvasElement>("back"),
    gl: get<HTMLCanvasElement>("gl"),
    front: get<HTMLCanvasElement>("front"),
    provider: get<HTMLElement>("provider"),
    status: get<HTMLElement>("status"),
    date: get<HTMLElement>("date"),
    year: get<HTMLElement>("year"),
    hour: get<HTMLElement>("hour"),
    time: get<HTMLInputElement>("time"),
    days: get<HTMLElement>("days"),
    play: get<HTMLButtonElement>("play"),
    month: get<HTMLSelectElement>("month"),
    unit: get<HTMLElement>("unit"),
    ramp: get<HTMLElement>("ramp"),
    ticks: get<HTMLElement>("ticks"),
    projection: get<HTMLSelectElement>("projection"),
    layer: get<HTMLSelectElement>("layer"),
  };
}

const landFeature = (topology: unknown) => {
  const t = topology as Topology<{ land: GeometryCollection }>;
  return feature(t, t.objects.land);
};

class ProjectionDemo {
  private readonly ui: ReturnType<typeof refs>;
  private readonly gl: WebGL2RenderingContext;
  private readonly raster: ProjectedRaster;
  private readonly particles: SphereParticles;
  private readonly overlay: Overlay;
  private ramp: WebGLTexture | null = null;
  private field: CurrentField | null = null;
  /** Month chunks of the open layer's archive. */
  private chunks: CatalogGeoVideoSource[] = [];
  private chunkIndex = 0;
  /** Particle settings of the open layer. */
  private particleSettings: ParticleSettings = particleSettings(
    undefined,
    undefined,
  );
  /** Next month, decoded ahead of the playhead. */
  private upcoming: Upcoming | null = null;
  /** Bumped on every layer or month switch; stale loads drop out. */
  private loadId = 0;
  private view: View;
  private dpr = 1;
  private ms = 0;
  private playing = true;
  private overlayKey = "";
  private lastMove = 0;
  private detailed = false;
  private last = 0;
  private transition: {
    start: number;
    rotate: (t: number) => [number, number, number];
    zoom: [number, number];
  } | null = null;
  private drag: {
    v0: [number, number, number];
    q0: ReturnType<typeof versor>;
    r0: [number, number, number];
  } | null = null;

  constructor(root: HTMLElement) {
    this.ui = refs(root);
    const gl = this.ui.gl.getContext("webgl2", {
      premultipliedAlpha: false,
      antialias: true,
      depth: true,
    });
    if (!gl) {
      throw new Error("WebGL2 is required");
    }
    this.gl = gl;
    this.raster = new ProjectedRaster(gl);
    this.particles = new SphereParticles(gl, 256, 32);
    this.overlay = new Overlay(this.ui.back, this.ui.front, {
      land: landFeature(land110),
      landDetail: landFeature(land50),
    });
    const preset = PRESETS[0];
    const def = PROJECTIONS[preset.projection];
    this.view = {
      blend: { a: def, b: def, ka: 1, kb: 1, t: 0 },
      rotate: preset.rotate,
      zoom: preset.zoom,
      width: 1,
      height: 1,
    };
    this.buildPickers(preset.id);
    this.bindInteraction();
    new ResizeObserver(() => this.resize()).observe(this.ui.stage);
    this.resize();
    requestAnimationFrame((now) => this.tick(now));
  }

  load(): Promise<void> {
    return this.openLayer(DEMO_LAYERS[0]);
  }

  /** Switch layer, keeping the displayed month when the archive has it. */
  private async openLayer(layer: DemoLayer): Promise<void> {
    const id = ++this.loadId;
    this.dropUpcoming();
    const entry = requireCatalogEntry(layer.entryId);
    const source = entry.sources.find(isGeoVideoArchiveSource);
    if (!source) {
      throw new Error(`No GeoVideo archive for ${layer.label}`);
    }
    this.setStatus(`Loading ${layer.label}…`);
    const index = await loadGeoVideoIndex(source.indexUrl);
    if (id !== this.loadId) {
      return;
    }
    const month = this.chunks[Number(this.ui.month.value)]?.temporal?.start;
    this.chunks = geoVideoChunkSources(source, index, entry);
    this.ui.month.replaceChildren(
      ...this.chunks.map(
        (chunk, i) => new Option(monthLabel(chunk), String(i)),
      ),
    );
    const same = this.chunks.findIndex((c) => c.temporal?.start === month);
    const chunkIndex = same >= 0 ? same : this.chunks.length - 1;
    this.ui.month.value = String(chunkIndex);
    this.ui.provider.textContent = providerLabel(source.provenance?.provider);
    this.overlay.fillLand = layer.fillLand;
    this.overlayKey = "";
    if (this.ramp) {
      this.gl.deleteTexture(this.ramp);
    }
    this.particleSettings = particleSettings(
      entry.defaults?.particles,
      layer.particles,
    );
    this.ramp = createColorRampTexture(
      this.gl as unknown as WebGLRenderingContext,
      layer.palette,
    );
    this.ui.ramp.style.background = rampGradient(layer.palette);
    await this.openChunk(this.chunks[chunkIndex], id);
  }

  private async openChunk(
    chunk: CatalogGeoVideoSource,
    id = ++this.loadId,
  ): Promise<void> {
    this.dropUpcoming();
    this.setStatus("Decoding…");
    const field = await this.loadField(chunk);
    if (id !== this.loadId) {
      field.destroy();
      return;
    }
    this.adopt(field, this.chunks.indexOf(chunk));
    this.buildLegend(field);
    this.particles.respawn();
  }

  /** Manifest and first decoded frame of a month chunk. */
  private async loadField(chunk: CatalogGeoVideoSource): Promise<CurrentField> {
    const manifest = await loadGeoVideoManifest(chunk.manifestUrl);
    const field = new CurrentField(this.gl, manifest);
    try {
      await field.prime(field.times[0]);
    } catch (error) {
      field.destroy();
      throw error;
    }
    return field;
  }

  private adopt(field: CurrentField, chunkIndex: number): void {
    this.field?.destroy();
    this.field = field;
    this.chunkIndex = chunkIndex;
    this.ui.month.value = String(chunkIndex);
    this.ms = field.times[0];
    this.buildDays(field.times);
    this.setStatus("");
  }

  /**
   * Decode the next month in the background so playback runs through the
   * whole archive like a film, wrapping to the first month after the last.
   */
  private prefetchNext(): void {
    if (this.upcoming || this.chunks.length < 2) {
      return;
    }
    const id = this.loadId;
    const index = (this.chunkIndex + 1) % this.chunks.length;
    const upcoming: Upcoming = { index, field: null };
    this.upcoming = upcoming;
    this.loadField(this.chunks[index])
      .then((field) => {
        if (this.upcoming === upcoming && id === this.loadId) {
          upcoming.field = field;
        } else {
          field.destroy();
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        if (this.upcoming === upcoming) {
          // Skip the unreadable month on the next attempt.
          this.chunkIndex = index;
          this.upcoming = null;
        }
      });
  }

  private dropUpcoming(): void {
    this.upcoming?.field?.destroy();
    this.upcoming = null;
  }

  private setStatus(text: string): void {
    if (this.ui.status.textContent !== text) {
      this.ui.status.textContent = text;
    }
  }

  // ---- projection & view -------------------------------------------------

  private buildPickers(activePreset: string): void {
    const { projection, layer, month } = this.ui;
    projection.replaceChildren(
      ...PRESETS.map((preset) => new Option(preset.label, preset.id)),
    );
    projection.value = activePreset;
    projection.addEventListener("change", () => {
      const preset = PRESETS.find((p) => p.id === projection.value);
      if (preset) {
        this.transitionTo(preset);
      }
    });
    layer.replaceChildren(
      ...DEMO_LAYERS.map((l) => new Option(l.label, l.entryId)),
    );
    layer.addEventListener("change", () => {
      const next = DEMO_LAYERS.find((l) => l.entryId === layer.value);
      if (next) {
        this.openLayer(next).catch((error: unknown) => this.fail(error));
      }
    });
    month.addEventListener("change", () => {
      const chunk = this.chunks[Number(month.value)];
      if (chunk) {
        this.openChunk(chunk).catch((error: unknown) => this.fail(error));
      }
    });
  }

  private fail(error: unknown): void {
    console.error(error);
    this.setStatus(String(error));
  }

  private transitionTo(preset: Preset): void {
    const { blend } = this.view;
    const from = blend.t < 0.5 ? blend.a : blend.b;
    const to = PROJECTIONS[preset.projection];
    const { width, height } = this.view;
    this.view.blend = {
      a: from,
      b: to,
      ka: fitScale(from, width, height),
      kb: fitScale(to, width, height),
      t: 0,
    };
    this.transition = {
      start: performance.now(),
      rotate: interpolateRotation(this.view.rotate, preset.rotate),
      zoom: [this.view.zoom, preset.zoom],
    };
  }

  private animate(now: number): void {
    const transition = this.transition;
    if (!transition) {
      return;
    }
    const raw = Math.min(1, (now - transition.start) / TRANSITION_MS);
    const e = easeCubicInOut(raw);
    this.view.blend.t = e;
    this.view.rotate = transition.rotate(e);
    this.view.zoom =
      transition.zoom[0] + (transition.zoom[1] - transition.zoom[0]) * e;
    if (raw >= 1) {
      const { b, kb } = this.view.blend;
      this.view.blend = { a: b, b, ka: kb, kb, t: 0 };
      this.transition = null;
    }
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.ui.stage;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [this.ui.back, this.ui.gl, this.ui.front]) {
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
    }
    const { blend } = this.view;
    this.view.width = width;
    this.view.height = height;
    blend.ka = fitScale(blend.a, width, height);
    blend.kb = fitScale(blend.b, width, height);
    this.overlayKey = "";
  }

  // ---- interaction -------------------------------------------------------

  private bindInteraction(): void {
    const stage = this.ui.front;
    stage.addEventListener("pointerdown", (event) => {
      if (this.transition) {
        return;
      }
      const at = this.invert(event, this.view.rotate);
      if (!at) {
        return;
      }
      stage.setPointerCapture(event.pointerId);
      this.ui.stage.classList.add("dragging");
      this.drag = {
        v0: cartesian(...at),
        q0: versor(this.view.rotate),
        r0: [...this.view.rotate],
      };
    });
    stage.addEventListener("pointermove", (event) => {
      const drag = this.drag;
      if (!drag) {
        return;
      }
      const at = this.invert(event, drag.r0);
      if (!at) {
        return;
      }
      const q1 = versorMultiply(
        drag.q0,
        versorDelta(drag.v0, cartesian(...at)),
      );
      this.view.rotate = versorRotation(q1);
    });
    const end = () => {
      this.drag = null;
      this.ui.stage.classList.remove("dragging");
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (this.transition) {
          return;
        }
        const zoom = this.view.zoom * Math.exp(-event.deltaY * 0.0015);
        this.view.zoom = Math.max(0.5, Math.min(8, zoom));
      },
      { passive: false },
    );

    this.ui.play.addEventListener("click", () =>
      this.setPlaying(!this.playing),
    );
    this.ui.time.addEventListener("input", () => {
      this.setPlaying(false);
      const times = this.field?.times;
      if (!times) {
        return;
      }
      this.ms =
        times[0] +
        Number(this.ui.time.value) * (times[times.length - 1] - times[0]);
    });
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && event.target === document.body) {
        event.preventDefault();
        this.setPlaying(!this.playing);
      }
    });
  }

  private invert(
    event: PointerEvent,
    rotate: [number, number, number],
  ): [number, number] | null {
    const projection = this.overlay.setView(
      viewFrame({ ...this.view, rotate }),
    );
    const at = projection.invert?.([event.offsetX, event.offsetY]);
    return at && Number.isFinite(at[0]) && Number.isFinite(at[1])
      ? [at[0], at[1]]
      : null;
  }

  private setPlaying(playing: boolean): void {
    this.playing = playing;
    this.ui.play.textContent = playing ? "❚❚" : "▶";
    this.ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  // ---- frame -------------------------------------------------------------

  private tick(now: number): void {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.animate(now);
    this.advanceTime(dt);

    const frame = viewFrame(this.view);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const field = this.field;
    if (field && this.ramp) {
      const style: ParticleStyle = {
        ramp: this.ramp,
        maxSpeed: field.maxSpeed,
        ...particleBudget(
          this.particleSettings,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
        ),
        opacity: 0.28,
        drop: 0.003,
      };
      this.raster.draw(frame, field, this.ms, {
        ramp: this.ramp,
        maxSpeed: field.maxSpeed,
        brightness: 0.5,
      });
      this.particles.step(frame, field, this.ms, style);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      this.particles.draw(frame, style);
    }

    const key = JSON.stringify([
      frame.rotate,
      frame.zoom,
      frame.blend.t,
      frame.blend.a.id,
      frame.blend.b.id,
      frame.width,
      frame.height,
    ]);
    if (key !== this.overlayKey) {
      this.overlayKey = key;
      this.lastMove = now;
      this.detailed = false;
      this.overlay.draw(frame, this.dpr, false);
    } else if (!this.detailed && now - this.lastMove > 180) {
      this.detailed = true;
      this.overlay.draw(frame, this.dpr, true);
    }
    requestAnimationFrame((t) => this.tick(t));
  }

  private advanceTime(dt: number): void {
    const times = this.field?.times;
    if (!times || times.length < 2) {
      return;
    }
    const first = times[0];
    const lastTime = times[times.length - 1];
    if (this.playing) {
      const stepMs = (lastTime - first) / (times.length - 1);
      this.ms += dt * STEPS_PER_SECOND * stepMs;
      if ((this.ms - first) / (lastTime - first) > PREFETCH_AT) {
        this.prefetchNext();
      }
      if (this.ms > lastTime) {
        const upcoming = this.upcoming;
        if (this.chunks.length < 2) {
          this.ms = first;
        } else if (upcoming?.field) {
          this.upcoming = null;
          this.adopt(upcoming.field, upcoming.index);
          return this.advanceTime(0);
        } else {
          this.ms = lastTime;
          this.setStatus("Buffering…");
        }
      }
      this.ui.time.value = String((this.ms - first) / (lastTime - first));
    }
    const date = new Date(this.ms);
    const day = date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    this.ui.date.textContent = day.toUpperCase();
    this.ui.year.textContent = String(date.getUTCFullYear());
    this.ui.hour.textContent = `${String(date.getUTCHours()).padStart(2, "0")}:00 UTC`;
  }

  private buildLegend(field: CurrentField): void {
    this.ui.unit.textContent = formatUnit(field.manifest.style.unit);
    this.ui.ticks.replaceChildren(
      ...legendTicks(field.maxSpeed).map((value) => {
        const li = document.createElement("li");
        li.textContent = String(value);
        li.style.bottom = `${rampPosition(value, field.maxSpeed) * 100}%`;
        return li;
      }),
    );
  }

  private buildDays(times: number[]): void {
    const ticks =
      times.length > 1 ? dayTicks(times[0], times[times.length - 1]) : [];
    this.ui.days.replaceChildren(
      ...ticks.map(({ label, position }) => {
        const li = document.createElement("li");
        li.textContent = label;
        li.style.top = `${position * 100}%`;
        return li;
      }),
    );
  }
}

function providerLabel(provider: string | undefined): string {
  return provider === "copernicus-marine" ? "Copernicus" : (provider ?? "");
}

function monthLabel(chunk: CatalogGeoVideoSource): string {
  const start = chunk.temporal?.start;
  if (!start) {
    return "—";
  }
  const date = new Date(start);
  const month = date.toLocaleDateString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });
  return `${month} ’${String(date.getUTCFullYear()).slice(2)}`;
}

const root = document.getElementById("app");
if (root) {
  try {
    const demo = new ProjectionDemo(root);
    demo.load().catch((error: unknown) => {
      console.error(error);
      root.querySelector('[data-ref="status"]')!.textContent = String(error);
    });
  } catch (error) {
    console.error(error);
    root.querySelector('[data-ref="status"]')!.textContent = String(error);
  }
}
