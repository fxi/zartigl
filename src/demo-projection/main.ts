import {
  PRESETS,
  PROJVERSOR_LAYERS,
  Projversor,
  SPEEDS,
  TINT_LAYERS,
  chunkLabel,
  decodeShare,
  encodeShare,
  findLayer,
  findPreset,
  formatUnit,
  layerPalettes,
  legendTicks,
  linearTicks,
  monthLegend,
  playheadLabel,
  rampGradient,
  rampPosition,
  timeTicks,
  type ProjversorLayer,
  type ProjversorMonth,
} from "../projversor";
import { Compass } from "./Compass";
import { GradePanel } from "./GradePanel";

/** Zoom button factor and rotate button step (degrees of longitude). */
const ZOOM_STEP = 1.5;
const ROTATE_STEP = 15;
/** How long the Share button confirms the copy. */
const COPIED_MS = 1500;

function refs(root: HTMLElement) {
  const get = <T extends Element>(name: string): T => {
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
    projectionName: get<HTMLElement>("projectionName"),
    status: get<HTMLElement>("status"),
    date: get<HTMLElement>("date"),
    hour: get<HTMLElement>("hour"),
    time: get<HTMLInputElement>("time"),
    zoomIn: get<HTMLButtonElement>("zoomIn"),
    zoomOut: get<HTMLButtonElement>("zoomOut"),
    rotateLeft: get<HTMLButtonElement>("rotateLeft"),
    rotateRight: get<HTMLButtonElement>("rotateRight"),
    days: get<HTMLElement>("days"),
    compass: get<HTMLButtonElement>("compass"),
    needle: get<SVGElement>("needle"),
    play: get<HTMLButtonElement>("play"),
    month: get<HTMLSelectElement>("month"),
    speed: get<HTMLSelectElement>("speed"),
    palette: get<HTMLSelectElement>("palette"),
    gradeToggle: get<HTMLButtonElement>("gradeToggle"),
    gradePanel: get<HTMLFormElement>("gradePanel"),
    unit: get<HTMLElement>("unit"),
    speedKey: get<HTMLElement>("speedKey"),
    speedMax: get<HTMLElement>("speedMax"),
    ramp: get<HTMLElement>("ramp"),
    ticks: get<HTMLElement>("ticks"),
    projection: get<HTMLSelectElement>("projection"),
    layer: get<HTMLSelectElement>("layer"),
    tintField: get<HTMLElement>("tintField"),
    tint: get<HTMLSelectElement>("tint"),
    share: get<HTMLButtonElement>("share"),
  };
}

/** The projversor controls: rail, pickers, timeline, legend and share. */
class ProjectionDemo {
  private readonly ui: ReturnType<typeof refs>;
  private readonly projversor: Projversor;
  private readonly compass: Compass;
  private readonly gradePanel: GradePanel;
  /** Timeline thumb held: playback waits for its release. */
  private scrubbing = false;
  private copiedTimer = 0;

  constructor(root: HTMLElement) {
    this.ui = refs(root);
    const shared = decodeShare(location.hash);
    const { stage, back, gl, front } = this.ui;
    const projversor = new Projversor({ stage, back, gl, front }, shared);
    this.projversor = projversor;
    this.compass = new Compass(this.ui.compass, this.ui.needle, {
      onBearing: (deg) => projversor.setBearing(deg),
      onToggle: () => projversor.toggleNorth(),
    });
    this.compass.locked = projversor.northLocked;
    this.gradePanel = new GradePanel(
      this.ui.gradeToggle,
      this.ui.gradePanel,
      (grade) => projversor.setGrade(grade),
    );
    this.gradePanel.value = projversor.grade;
    this.buildPickers(projversor.preset.id);
    this.bindRenderer();
    this.bindControls();
    this.setPlaying(projversor.playing);
    projversor.attachInteraction();
    projversor.apply(shared, { animate: false }).catch((error: unknown) => {
      this.fail(error);
    });
  }

  private bindRenderer(): void {
    const p = this.projversor;
    p.on("status", (text) => this.setStatus(text));
    p.on("layer", (layer) => this.syncLayer(layer));
    p.on("month", (month) => {
      this.ui.month.value = String(p.chunkIndex);
      this.buildDays(p.times);
      this.buildLegend(month);
    });
    p.on("palette", (id) => {
      this.ui.palette.value = id;
      this.ui.ramp.style.background = rampGradient(id);
    });
    p.on("playing", (playing) => this.setPlaying(playing));
    p.on("preset", (preset) => {
      this.ui.projection.value = preset.id;
      this.ui.projectionName.textContent = preset.label;
    });
    p.on("north", (locked) => (this.compass.locked = locked));
    p.on("frame", () => {
      this.compass.bearing = p.bearing;
      if (!this.scrubbing) {
        this.setTimeline(p.progress);
      }
      const times = p.times;
      if (times.length < 2) {
        return;
      }
      const stepMs = (times[times.length - 1] - times[0]) / (times.length - 1);
      const { date, hour } = playheadLabel(p.time, stepMs);
      this.ui.date.textContent = date;
      this.ui.hour.textContent = hour;
      this.ui.hour.hidden = !hour;
    });
  }

  /** Month, layer, tint, speed and palette pickers for the open layer. */
  private syncLayer(layer: ProjversorLayer): void {
    const p = this.projversor;
    const { month, tint, tintField, speed, palette } = this.ui;
    month.replaceChildren(
      ...p.chunks.map(
        (chunk, i) =>
          new Option(
            chunkLabel(chunk.temporal?.start, chunk.temporal?.end),
            String(i),
          ),
      ),
    );
    month.value = String(p.chunkIndex);
    this.ui.provider.textContent = providerLabel(
      p.chunks[0]?.provenance?.provider,
    );
    this.ui.layer.value = layer.id;
    tintField.hidden = layer.kind !== "vector";
    this.gradePanel.available = layer.kind === "vector";
    tint.value = p.tintId ?? "";
    speed.replaceChildren(
      ...SPEEDS[layer.kind].map((s) => new Option(`${s}×`, String(s))),
    );
    speed.value = String(p.speed);
    palette.replaceChildren(
      ...layerPalettes(layer).map((pal) => new Option(pal.label, pal.id)),
    );
  }

  private buildPickers(activePreset: string): void {
    const { projection, layer, tint } = this.ui;
    projection.replaceChildren(
      ...PRESETS.map((preset) => new Option(preset.label, preset.id)),
    );
    projection.value = activePreset;
    this.ui.projectionName.textContent = projection.selectedOptions[0].text;
    layer.replaceChildren(
      optionGroup("Flows", PROJVERSOR_LAYERS, "vector"),
      optionGroup("Fields", PROJVERSOR_LAYERS, "scalar"),
    );
    tint.replaceChildren(
      new Option("Speed", ""),
      ...TINT_LAYERS.map((l) => new Option(l.label, l.entryId)),
    );
  }

  private bindControls(): void {
    const p = this.projversor;
    const { projection, layer, tint, month, speed, palette } = this.ui;
    const run = (task: Promise<void>) =>
      task.catch((error: unknown) => this.fail(error));
    projection.addEventListener("change", () => {
      if (findPreset(projection.value)) {
        p.goTo({ preset: projection.value });
      }
    });
    layer.addEventListener("change", () => {
      const next = findLayer(layer.value);
      if (next) {
        void run(p.open(next));
      }
    });
    tint.addEventListener("change", () => {
      void run(
        p.open(p.layer, {
          at: p.time,
          palette: p.palette,
          tint: tint.value || null,
          frame: false,
        }),
      );
    });
    month.addEventListener("change", () => {
      void run(p.openMonth(Number(month.value)));
    });
    speed.addEventListener("change", () => p.setSpeed(Number(speed.value)));
    palette.addEventListener("change", () => p.setPalette(palette.value));

    this.ui.play.addEventListener("click", () => p.setPlaying(!p.playing));
    this.ui.share.addEventListener("click", () => this.share());
    this.ui.zoomIn.addEventListener("click", () => p.zoomBy(ZOOM_STEP));
    this.ui.zoomOut.addEventListener("click", () => p.zoomBy(1 / ZOOM_STEP));
    this.ui.rotateLeft.addEventListener("click", () =>
      p.rotateBy(-ROTATE_STEP),
    );
    this.ui.rotateRight.addEventListener("click", () =>
      p.rotateBy(ROTATE_STEP),
    );

    // The thumb drives the playhead like a jog wheel: playback holds while
    // it is held (pointer or key) and resumes on release.
    const time = this.ui.time;
    const hold = (held: boolean) => {
      this.scrubbing = held;
      p.setHeld(held);
    };
    time.addEventListener("pointerdown", (event) => {
      time.setPointerCapture(event.pointerId);
      hold(true);
    });
    time.addEventListener("keydown", () => hold(true));
    for (const type of ["pointerup", "pointercancel", "keyup", "blur"]) {
      time.addEventListener(type, () => hold(false));
    }
    time.addEventListener("input", () => {
      const times = p.times;
      if (times.length < 2) {
        return;
      }
      const span = times[times.length - 1] - times[0];
      p.scrub(times[0] + Number(time.value) * span);
      time.style.setProperty("--p", time.value);
    });
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && event.target === document.body) {
        event.preventDefault();
        p.setPlaying(!p.playing);
      }
    });
  }

  private setStatus(text: string): void {
    if (this.ui.status.textContent !== text) {
      this.ui.status.textContent = text;
    }
  }

  private fail(error: unknown): void {
    console.error(error);
    this.setStatus(String(error));
  }

  /** Copy a link to the displayed view. */
  private share(): void {
    const url = new URL(location.href);
    url.hash = encodeShare(this.projversor.getState());
    // navigator.clipboard is missing outside secure contexts.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(url.href))
      .then(
        () => {
          const button = this.ui.share;
          button.classList.add("copied");
          button.setAttribute("aria-label", "Link copied");
          clearTimeout(this.copiedTimer);
          this.copiedTimer = window.setTimeout(() => {
            button.classList.remove("copied");
            button.setAttribute("aria-label", "Share");
          }, COPIED_MS);
        },
        () => this.setStatus(url.href),
      );
  }

  private setPlaying(playing: boolean): void {
    this.ui.play.classList.toggle("playing", playing);
    this.ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  /** Thumb position and the played part of the track, 0–1. */
  private setTimeline(value: number): void {
    this.ui.time.value = String(value);
    this.ui.time.style.setProperty("--p", String(value));
  }

  /**
   * Ramp ticks and unit: a scalar raster or the tint over its domain
   * (linear), the tint with a speed brightness key, else the speed
   * (square-root ramp).
   */
  private buildLegend({ field, tint }: ProjversorMonth): void {
    const speedUnit = formatUnit(field.manifest.style.unit);
    const tick = (value: number, position: number) => {
      const li = document.createElement("li");
      li.textContent = String(value);
      li.style.bottom = `${position * 100}%`;
      return li;
    };
    this.ui.speedKey.hidden = !tint;
    const legend = monthLegend({ field, tint });
    this.ui.unit.textContent = legend.unit;
    if (legend.ramp === "linear") {
      this.ui.ticks.replaceChildren(
        ...linearTicks(legend.min, legend.max).map((t) =>
          tick(t.value, t.position),
        ),
      );
      this.ui.speedMax.textContent = `${field.maxSpeed} ${speedUnit}`;
      return;
    }
    this.ui.ticks.replaceChildren(
      ...legendTicks(legend.max).map((value) =>
        tick(value, rampPosition(value, legend.max)),
      ),
    );
  }

  private buildDays(times: readonly number[]): void {
    const ticks =
      times.length > 1 ? timeTicks(times[0], times[times.length - 1]) : [];
    this.ui.days.replaceChildren(
      ...ticks.map(({ label, position, major }) => {
        const li = document.createElement("li");
        if (major) {
          li.textContent = label;
        } else {
          li.className = "minor";
        }
        li.style.top = `${position * 100}%`;
        return li;
      }),
    );
  }
}

function optionGroup(
  label: string,
  layers: readonly ProjversorLayer[],
  kind: ProjversorLayer["kind"],
): HTMLOptGroupElement {
  const group = document.createElement("optgroup");
  group.label = label;
  group.append(
    ...layers
      .filter((l) => l.kind === kind)
      .map((l) => new Option(l.label, l.id)),
  );
  return group;
}

function providerLabel(provider: string | undefined): string {
  return provider === "copernicus-marine" ? "Copernicus" : (provider ?? "");
}

const root = document.getElementById("app");
if (root) {
  try {
    new ProjectionDemo(root);
  } catch (error) {
    console.error(error);
    root.querySelector('[data-ref="status"]')!.textContent = String(error);
  }
}
