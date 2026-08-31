import type { Map as MaplibreMap, LngLat } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
import type { FolderApi, BindingApi, BladeApi } from "@tweakpane/core";
import {
  buildMapxWidgetSnippet,
  buildStandaloneDemoSnippet,
  Zartigl,
  deriveDirectionMagnitudeComponents,
  getPalettes,
  resolveTimeInputSelection,
} from "../lib";
import type {
  RenderMode,
  ZarrPointSeriesResult,
  ZartiglDebugInfo,
  ZartiglSettings,
  ZartiglStatus,
  TimeGranularity,
} from "../lib";
import { formatTime, formatVertical, resolveLocalizedText, searchCatalog } from "../catalog";
import type { CatalogEntry, Catalog, CatalogSource, CatalogZarrSource } from "../catalog";
import { addDomBlade, DomBladePlugin } from "./DomBladePlugin";

// ── Types ─────────────────────────────────────────────────────────────

interface DemoParams {
  timeIndex: number;
  timeLabel: string;
  allowedStart: number;
  allowedEnd: number;
  geoVideoAutoplay: boolean;
  geoVideoLoop: boolean;
  geoVideoPlaybackRate: number;
  depth: number;
  particleDensity: number;
  speed: number;
  fade: number;
  renderMode: RenderMode;
  palette: string;
  opacity: number;
  logScale: boolean;
  vibrance: number;
  colorDomain: [number, number] | null;
  colorDomainMin: number;
  colorDomainMax: number;
}

interface HashState {
  d: string;
  t: number;
  v: number;
  p: string;
  s?: string;
  pr?: "mercator" | "globe";
  c?: [number, number];
  z?: number;
  b?: number;
  pi?: number;
  pd: number;
  sp?: number;
  f?: number;
  rm?: RenderMode;
  op: number;
  ls: boolean;
  vb: number;
  cd?: [number, number] | null;
  tr?: [number, number];
  ga?: boolean;
  gl?: boolean;
  gr?: number;
}

type PopupMode = "time" | "depth";

interface ChartDatum {
  axis: number;
  value: number;
  time?: number;
  depth?: number;
  u?: number;
  v?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

function showToast(msg: string): void {
  const el = document.createElement("div");
  el.className = "copy-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function formatValue(v: number, unit: string): string {
  if (!Number.isFinite(v)) return "nodata";
  const abs = Math.abs(v);
  const txt = abs >= 100 ? v.toFixed(1) : abs >= 10 ? v.toFixed(2) : v.toFixed(3);
  return unit ? `${txt} ${unit}` : txt;
}

function codeNumber(value: number, digits = 6): string {
  return String(Number(value.toFixed(digits)));
}

function zarrSource(layer: CatalogEntry): CatalogZarrSource {
  const configured = layer.defaults.querySourceId ?? layer.defaults.sourceId;
  const source = layer.sources.find((candidate) => candidate.id === configured && candidate.type === "zarr")
    ?? layer.sources.find((candidate): candidate is CatalogZarrSource => candidate.type === "zarr");
  if (!source || source.type !== "zarr") throw new Error(`Catalog entry has no Zarr variables: ${layer.id}`);
  return source;
}

function getPointVariables(layer: CatalogEntry): string[] {
  const variables = zarrSource(layer).variables;
  if (variables.kind === "scalar") return [variables.value];
  if (variables.derivation) {
    return [
      variables.derivation.direction_variable,
      variables.derivation.magnitude_variable,
    ];
  }
  return [variables.u ?? "uo", variables.v ?? "vo"];
}

function nearestTimeIndex(values: readonly number[], target: number): number {
  if (values.length === 0) return 0;
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
  }
  return best;
}

function authoringInputType(granularity: TimeGranularity): "month" | "date" | "datetime-local" {
  if (granularity === "month") return "month";
  if (granularity === "day" || granularity === "year") return "date";
  return "datetime-local";
}

function authoringInputValue(time: number, granularity: TimeGranularity): string {
  const iso = new Date(time).toISOString();
  if (granularity === "year") return iso.slice(0, 4);
  if (granularity === "month") return iso.slice(0, 7);
  if (granularity === "day") return iso.slice(0, 10);
  return iso.slice(0, granularity === "second" ? 19 : 16);
}

function pointResultToData(
  result: ZarrPointSeriesResult,
  layer: CatalogEntry,
): ChartDatum[] {
  const variables = getPointVariables(layer);
  const sourceVariables = zarrSource(layer).variables;
  const isVector = layer.kind === "vector";

  return result.points.map((point) => {
    let u = point.values[variables[0]];
    let v = isVector ? point.values[variables[1]] : undefined;

    if (sourceVariables.kind === "vector" && sourceVariables.derivation) {
      const components = deriveDirectionMagnitudeComponents(
        point.values[sourceVariables.derivation.direction_variable],
        point.values[sourceVariables.derivation.magnitude_variable],
        sourceVariables.derivation,
      );
      u = components.u;
      v = components.v;
    }

    const value = isVector
      ? (Number.isFinite(u) && Number.isFinite(v) ? Math.hypot(u, v!) : NaN)
      : u;

    return {
      axis: point.axisValue,
      value,
      time: point.time,
      depth: point.depth,
      u,
      v,
    };
  });
}

function nearestDatum(data: ChartDatum[], target: number, mode: PopupMode): ChartDatum | null {
  let best: ChartDatum | null = null;
  let bestDist = Infinity;
  for (const datum of data) {
    const axis = mode === "time"
      ? (datum.time ?? datum.axis)
      : (datum.depth ?? datum.axis);
    const dist = Math.abs(axis - target);
    if (dist < bestDist) {
      best = datum;
      bestDist = dist;
    }
  }
  return best;
}

function setPopupStatus(body: HTMLElement, message: string, cls = "query-loading"): void {
  body.replaceChildren();
  const status = document.createElement("div");
  status.className = cls;
  status.textContent = message;
  body.appendChild(status);
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function renderPointChart(
  host: HTMLElement,
  data: ChartDatum[],
  mode: PopupMode,
  unit: string,
  verticalLabel = "depth",
  verticalUnits?: string,
): void {
  host.replaceChildren();
  const finite = data.filter((datum) => Number.isFinite(datum.value));
  if (!finite.length) {
    setPopupStatus(host, "No valid samples at this point.", "query-empty");
    return;
  }

  const width = 320;
  const height = 170;
  const margin = { top: 12, right: 14, bottom: 30, left: 44 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const valueMin = Math.min(...finite.map((datum) => datum.value));
  const valueMax = Math.max(...finite.map((datum) => datum.value));
  const valueSpan = valueMax - valueMin || 1;
  const paddedMin = valueMin - valueSpan * 0.08;
  const paddedMax = valueMax + valueSpan * 0.08;

  const axisValue = (datum: ChartDatum) =>
    mode === "time" ? (datum.time ?? datum.axis) : (datum.depth ?? datum.axis);
  const axisMin = Math.min(...finite.map(axisValue));
  const axisMax = Math.max(...finite.map(axisValue));
  const axisSpan = axisMax - axisMin || 1;

  const sx = (axis: number) => margin.left + ((axis - axisMin) / axisSpan) * innerW;
  const sy = (value: number) =>
    margin.top + innerH - ((value - paddedMin) / (paddedMax - paddedMin || 1)) * innerH;
  const depthX = (value: number) =>
    margin.left + ((value - paddedMin) / (paddedMax - paddedMin || 1)) * innerW;
  const depthY = (axis: number) => margin.top + ((axis - axisMin) / axisSpan) * innerH;

  const sorted = [...data].sort((a, b) => axisValue(a) - axisValue(b));
  const path = sorted
    .filter((datum) => Number.isFinite(datum.value))
    .map((datum, index) => {
      const x = mode === "time" ? sx(axisValue(datum)) : depthX(datum.value);
      const y = mode === "time" ? sy(datum.value) : depthY(axisValue(datum));
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "query-chart",
  });
  const frame = svgEl("rect", {
    x: margin.left,
    y: margin.top,
    width: innerW,
    height: innerH,
    class: "query-chart-frame",
  });
  const line = svgEl("path", { d: path, class: "query-chart-line" });
  svg.append(frame, line);

  const xMinLabel = mode === "time"
    ? formatTime(axisMin)
    : paddedMin.toPrecision(3);
  const xMaxLabel = mode === "time"
    ? formatTime(axisMax)
    : paddedMax.toPrecision(3);
  const yMinLabel = mode === "time"
    ? paddedMin.toPrecision(3)
    : formatVertical(axisMin, verticalLabel, verticalUnits);
  const yMaxLabel = mode === "time"
    ? paddedMax.toPrecision(3)
    : formatVertical(axisMax, verticalLabel, verticalUnits);

  const labels: Array<[number, number, string, string]> = [
    [margin.left, height - 10, xMinLabel, "start"],
    [margin.left + innerW, height - 10, xMaxLabel, "end"],
    [6, margin.top + innerH, yMinLabel, "start"],
    [6, margin.top + 8, yMaxLabel, "start"],
  ];

  for (const [x, y, text, anchor] of labels) {
    const label = svgEl("text", {
      x,
      y,
      class: "query-chart-label",
      "text-anchor": anchor,
    });
    label.textContent = text;
    svg.appendChild(label);
  }

  if (unit) {
    const unitLabel = svgEl("text", {
      x: margin.left,
      y: height - 2,
      class: "query-chart-unit",
    });
    unitLabel.textContent = unit;
    svg.appendChild(unitLabel);
  }

  host.appendChild(svg);
}

// ── DemoApp ───────────────────────────────────────────────────────────

export class DemoApp {
  private z: Zartigl | null = null;
  private readonly pane: Pane;
  private params: DemoParams;
  private currentLayer: CatalogEntry;
  private currentBackend: "zarr" | "geovideo" | "wmts" = "zarr";
  private currentSourceId = "";
  private readonly locale = navigator.language || "en";
  private currentProjection: "mercator" | "globe" = "mercator";
  private activePopup: maplibregl.Popup | null = null;
  private switchSeq = 0;
  private pointQuerySeq = 0;

  // Folder refs
  private dataFolder!: FolderApi;
  private vectorFolder!: FolderApi;
  private dataBindings: { dispose(): void }[] = [];
  private dataStatusBlade!: BladeApi;
  private timeSliderBinding: BindingApi | null = null;
  private timeLabelBinding: BindingApi | null = null;
  private syncingVideoTimeControls = false;

  // DOM refs
  private layerSearchInput!: HTMLInputElement;
  private layerResultsEl!: HTMLDivElement;
  private layerResultCountEl!: HTMLSpanElement;
  private layerDetailsEl!: HTMLDivElement;
  private layerResults: CatalogEntry[] = [];
  private layerActiveIndex = -1;
  private paletteSelectEl!: HTMLSelectElement;
  private sourceBlade!: BladeApi;
  private sourceSelectEl!: HTMLSelectElement;
  private projButtons: { proj: string; btn: HTMLButtonElement }[] = [];
  private legendBar!: HTMLDivElement;
  private legendMin!: HTMLSpanElement;
  private legendMax!: HTMLSpanElement;
  private legendUnit!: HTMLSpanElement;
  private legendImg!: HTMLImageElement;
  private gradientSection!: HTMLDivElement;
  private colorDomainMinBinding!: BindingApi;
  private colorDomainMaxBinding!: BindingApi;
  private colorDomainAutoButton!: ReturnType<FolderApi["addButton"]>;
  private colorDomainControls: { hidden: boolean }[] = [];
  private frameColorDomain: [number, number] | null = null;
  private syncingColorDomainControls = false;
  private fpsEl!: HTMLDivElement;
  private dataStatusEl!: HTMLDivElement;
  private fpsFrameCount = 0;
  private fpsLastSample = 0;
  private currentFps = 0;
  private fpsRafId = 0;

  constructor(private readonly map: MaplibreMap, private readonly cat: Catalog) {
    const hash = this.loadHashState();
    this.currentLayer = cat.layers.find((entry) => entry.id === hash?.d) ?? cat.layers[0];
    this.currentSourceId = this.currentLayer.defaults.sourceId;
    this.params = this.makeDefaultParams();

    this.pane = new Pane({ title: "zartigl", expanded: true });
    this.pane.registerPlugin(DomBladePlugin);
    this.buildStaticUI();
    this.buildFpsCounter();
    this.startFpsCounter();
    this.applyHashCamera(hash);

    void this.switchLayer(this.currentLayer, hash);
    this.map.on("click", (ev) => void this.onMapClick(ev.lngLat));
  }

  // ── Layer switching ─────────────────────────────────────────────────

  async switchLayer(layer: CatalogEntry, hashState?: HashState | null): Promise<void> {
    const seq = ++this.switchSeq;
    this.pointQuerySeq++;
    this.frameColorDomain = null;

    this.activePopup?.remove();
    this.activePopup = null;

    const requestedSource = layer.sources.find((source) => source.id === hashState?.s)
      ?? layer.sources.find((source) => source.id === this.currentSourceId)
      ?? layer.sources.find((source) => source.id === layer.defaults.sourceId)
      ?? layer.sources[0];
    this.currentSourceId = requestedSource.id;
    this.currentBackend = requestedSource.type;

    // Apply params: layer defaults, then optional hash overrides
    this.applyLayerDefaults(layer);
    if (hashState) this.applyHashState(hashState, layer);

    this.currentLayer = layer;

    this.z?.destroy();
    this.z = new Zartigl({
      id: "prod-zartigl",
      map: this.map,
      catalog: this.cat,
      source: this.currentSourceId,
      timeRange: hashState?.tr
        ? { start: hashState.tr[0], end: hashState.tr[1] }
        : undefined,
      geoVideo: {
        autoplay: hashState?.ga ?? this.params.geoVideoAutoplay,
        loop: hashState?.gl ?? this.params.geoVideoLoop,
        playbackRate: hashState?.gr ?? this.params.geoVideoPlaybackRate,
      },
      visible: true,
    });
    const activeZartigl = this.z;
    activeZartigl.on("loaded", (meta) => {
      if (this.z !== activeZartigl || seq !== this.switchSeq) return;
      if (layer.kind === "scalar") this.frameColorDomain = [meta.min, meta.max];
      this.syncLegend();
    });
    activeZartigl.on("status", (status) => {
      if (this.z === activeZartigl && seq === this.switchSeq) this.updateDataStatus(status);
    });
    let lastVideoUiUpdate = 0;
    activeZartigl.on("timeChange", (time) => {
      if (this.z !== activeZartigl || seq !== this.switchSeq || this.currentBackend !== "geovideo") return;
      const now = performance.now();
      if (now - lastVideoUiUpdate < 200) return;
      lastVideoUiUpdate = now;
      const values = activeZartigl.getTimeMeta().values;
      this.params.timeIndex = nearestTimeIndex(values, time);
      this.params.timeLabel = formatTime(time);
      this.syncingVideoTimeControls = true;
      try {
        this.timeSliderBinding?.refresh();
        this.timeLabelBinding?.refresh();
      } finally {
        this.syncingVideoTimeControls = false;
      }
    });

    await activeZartigl.setLayer(layer.id);
    if (seq !== this.switchSeq) return;
    const activeSource = activeZartigl.getSource();
    if (activeSource) { this.currentSourceId = activeSource.id; this.currentBackend = activeSource.type; }

    const timeMeta = this.z.getTimeMeta();
    const depthMeta = this.z.getDepthMeta();
    const times = timeMeta.values ?? [];
    const tSize = times.length;
    this.params.allowedStart = timeMeta.min;
    this.params.allowedEnd = timeMeta.max;
    this.params.geoVideoAutoplay = hashState?.ga ?? this.params.geoVideoAutoplay;
    this.params.geoVideoLoop = hashState?.gl ?? this.params.geoVideoLoop;
    this.params.geoVideoPlaybackRate = hashState?.gr ?? this.params.geoVideoPlaybackRate;

    if (hashState) {
      this.params.timeIndex = Math.max(0, Math.min(
        nearestTimeIndex(times, hashState.t),
        tSize - 1,
      ));
      this.params.timeLabel = formatTime(times[this.params.timeIndex]);
      this.params.depth = depthMeta.values.includes(hashState.v)
        ? hashState.v
        : (depthMeta.values[0] ?? 0);
    } else {
      this.params.timeIndex = nearestTimeIndex(times, timeMeta.current ?? timeMeta.max);
      this.params.timeLabel = formatTime(times[this.params.timeIndex]);
      this.params.depth = depthMeta.values[0] ?? 0;
    }

    this.z.updateSettings(this.buildSettings());
    this.z.setTimeAndDepth(times[this.params.timeIndex], this.params.depth);

    this.rebuildDataUI();

    const isVector = layer.kind === "vector";
    this.vectorFolder.hidden = !isVector;
    this.updateSourceVisibility();
    this.syncColorDomainVisibility();
    this.updateLayerSelect();

    if (this.paletteSelectEl) this.paletteSelectEl.value = this.params.palette;
    this.pane.refresh();

    setTimeout(() => this.syncLegend(), 400);
  }

  private async switchSource(source: CatalogSource): Promise<void> {
    if (!this.z || source.id === this.currentSourceId) return;
    await this.z.setSource(source.id);
    this.currentSourceId = source.id;
    this.currentBackend = source.type;
    const timeMeta = this.z.getTimeMeta();
    this.params.allowedStart = timeMeta.min;
    this.params.allowedEnd = timeMeta.max;
    this.params.timeIndex = nearestTimeIndex(timeMeta.values, timeMeta.current ?? timeMeta.max);
    this.params.depth = this.z.getDepthMeta().current ?? 0;
    this.rebuildDataUI();
    this.renderSourceSelect();
    this.syncColorDomainVisibility();
    this.syncLegend();
  }

  // ── Data UI (rebuilt per layer) ─────────────────────────────────────

  private rebuildDataUI(): void {
    for (const b of this.dataBindings) b.dispose();
    this.dataBindings = [];
    this.timeSliderBinding = null;
    this.timeLabelBinding = null;

    const timeMeta = this.z!.getTimeMeta();
    const times = timeMeta.values ?? [];
    const tSize = times.length;

    this.dataBindings.push(this.buildAllowedRangeControls());

    this.timeSliderBinding = this.dataFolder.addBinding(this.params, "timeIndex", {
      min: 0,
      max: Math.max(0, tSize - 1),
      step: 1,
      label: "time",
    }).on("change", (ev) => {
      if (this.syncingVideoTimeControls) return;
      const ms = times[ev.value];
      this.params.timeLabel = formatTime(ms);
      this.timeLabelBinding?.refresh();
      this.z?.setTime(ms);
    }) as BindingApi;

    this.timeLabelBinding = this.dataFolder.addBinding(this.params, "timeLabel", {
      readonly: true,
      label: "",
    }) as BindingApi;

    const depthMeta = this.z!.getDepthMeta();
    let depthBinding: BindingApi | null = null;
    if (depthMeta.values.length > 0) {
      depthBinding = this.dataFolder.addBinding(this.params, "depth", {
        options: depthMeta.values.map((v) => ({
          text: formatVertical(v, depthMeta.label, depthMeta.units),
          value: v,
        })),
        label: depthMeta.label,
      }).on("change", (ev) => this.z?.setDepth(ev.value)) as BindingApi;
    }

    this.dataBindings.push(
      this.timeSliderBinding,
      this.timeLabelBinding,
    );
    if (depthBinding) this.dataBindings.push(depthBinding);
    if (this.currentBackend === "geovideo") {
      const autoplay = this.dataFolder.addBinding(this.params, "geoVideoAutoplay", {
        label: "autoplay",
      }).on("change", (event) => {
        if (event.value) void this.z?.play();
        else this.z?.pause();
      });
      const loop = this.dataFolder.addBinding(this.params, "geoVideoLoop", {
        label: "loop",
      }).on("change", (event) => this.z?.setLoop(event.value));
      const rate = this.dataFolder.addBinding(this.params, "geoVideoPlaybackRate", {
        label: "playback rate",
        options: [0.5, 1, 2, 5, 10].map((value) => ({ text: `${value}×`, value })),
      }).on("change", (event) => this.z?.setPlaybackRate(event.value));
      this.dataBindings.push(autoplay, loop, rate);
    }

    // Status is static, but moving its blade to the end keeps it below controls
    // that are rebuilt for each layer/source/range change.
    this.dataFolder.add(this.dataStatusBlade);
  }

  private buildAllowedRangeControls(): FolderApi {
    const folder = this.dataFolder.addFolder({ title: "Allowed range", expanded: false });
    const full = this.z!.getTimeMeta({ full: true });
    const row = document.createElement("div");
    row.className = "allowed-range";

    const makeInput = (side: "start" | "end"): HTMLInputElement | HTMLSelectElement => {
      const label = document.createElement("label");
      label.textContent = side;
      const input = full.granularity === "year"
        ? document.createElement("select")
        : document.createElement("input");
      if (input instanceof HTMLInputElement) {
        input.type = authoringInputType(full.granularity);
        input.min = authoringInputValue(full.min, full.granularity);
        input.max = authoringInputValue(full.max, full.granularity);
        input.step = full.granularity === "second"
          ? String(Math.max(1, (full.step ?? 1_000) / 1_000))
          : full.granularity === "minute" || full.granularity === "hour"
            ? String(Math.max(60, (full.step ?? 60_000) / 1_000))
            : "1";
      } else {
        const years = [...new Set(full.values.map((time) => new Date(time).getUTCFullYear()))];
        for (const year of years) {
          const option = document.createElement("option");
          option.value = String(year);
          option.textContent = String(year);
          input.appendChild(option);
        }
      }
      input.className = "allowed-range-input";
      input.value = authoringInputValue(
        side === "start" ? this.params.allowedStart : this.params.allowedEnd,
        full.granularity,
      );
      input.addEventListener("change", () => {
        const snapped = resolveTimeInputSelection(
          full.values,
          input.value,
          full.granularity,
        );
        if (snapped === undefined) return;
        if (side === "start") {
          this.params.allowedStart = snapped;
          if (snapped > this.params.allowedEnd) this.params.allowedEnd = snapped;
        } else {
          this.params.allowedEnd = snapped;
          if (snapped < this.params.allowedStart) this.params.allowedStart = snapped;
        }
        this.applyAuthoredRange();
      });
      label.appendChild(input);
      row.appendChild(label);
      return input;
    };
    makeInput("start");
    makeInput("end");
    folder.addButton({ title: "Full range" }).on("click", () => {
      this.params.allowedStart = full.min;
      this.params.allowedEnd = full.max;
      this.applyAuthoredRange();
    });
    addDomBlade(folder, row);
    return folder;
  }

  private applyAuthoredRange(): void {
    if (!this.z) return;
    const full = this.z.getTimeMeta({ full: true });
    const isFull = this.params.allowedStart === full.min && this.params.allowedEnd === full.max;
    const meta = this.z.setTimeRange(isFull ? null : {
      start: this.params.allowedStart,
      end: this.params.allowedEnd,
    });
    this.params.allowedStart = meta.min;
    this.params.allowedEnd = meta.max;
    this.params.timeIndex = nearestTimeIndex(meta.values, meta.current ?? meta.min);
    this.params.timeLabel = formatTime(meta.values[this.params.timeIndex]);
    this.rebuildDataUI();
  }

  // ── Static UI (built once) ──────────────────────────────────────────

  private buildStaticUI(): void {
    this.buildLayerFolder();
    this.dataFolder = this.pane.addFolder({ title: "Data", expanded: true });
    this.dataStatusEl = document.createElement("div");
    this.dataStatusEl.className = "data-status";
    this.dataStatusEl.dataset.phase = "idle";
    this.dataStatusEl.textContent = "Idle";
    this.dataStatusBlade = addDomBlade(this.dataFolder, this.dataStatusEl);
    this.buildDisplayFolder();
    this.buildVectorFolder();
    this.buildExportFolder();
  }

  private updateDataStatus(status: ZartiglStatus): void {
    this.dataStatusEl.dataset.phase = status.phase;
    switch (status.phase) {
      case "metadata":
        this.dataStatusEl.textContent = "Fetching metadata…";
        break;
      case "fetching":
        this.dataStatusEl.textContent = `Fetching ${status.completed}/${status.total}…`;
        break;
      case "rendering":
        this.dataStatusEl.textContent = "Rendering…";
        break;
      case "ready":
        this.dataStatusEl.textContent = "Ready";
        break;
      case "blocked":
        this.dataStatusEl.textContent = status.message;
        break;
      case "error":
        this.dataStatusEl.textContent = `Error: ${status.error.message}`;
        break;
    }
  }

  private buildFpsCounter(): void {
    this.fpsEl = document.createElement("div");
    this.fpsEl.className = "demo-fps";
    this.fpsEl.textContent = "FPS -- | state auto";
    document.body.appendChild(this.fpsEl);
  }

  private startFpsCounter(): void {
    const tick = (now: number): void => {
      if (this.fpsLastSample === 0) {
        this.fpsLastSample = now;
      }

      this.fpsFrameCount++;
      const elapsed = now - this.fpsLastSample;
      if (elapsed >= 500) {
        const fps = (this.fpsFrameCount * 1000) / elapsed;
        this.currentFps = Math.round(fps);
        this.updateDebugStatus();
        this.fpsFrameCount = 0;
        this.fpsLastSample = now;
      }

      this.fpsRafId = requestAnimationFrame(tick);
    };

    this.fpsRafId = requestAnimationFrame(tick);
  }

  private buildLayerFolder(): void {
    const folder = this.pane.addFolder({ title: "Layer", expanded: true });
    const picker = document.createElement("div");
    picker.className = "catalog-picker";

    const searchRow = document.createElement("div");
    searchRow.className = "catalog-search-row";
    const input = document.createElement("input");
    input.className = "catalog-search-input";
    input.type = "search";
    input.placeholder = "Search catalog…";
    input.setAttribute("aria-label", "Search catalog");
    input.setAttribute("aria-controls", "zartigl-catalog-results");
    const clear = document.createElement("button");
    clear.className = "catalog-search-clear";
    clear.type = "button";
    clear.textContent = "×";
    clear.title = "Clear search";
    clear.setAttribute("aria-label", "Clear catalog search");
    searchRow.append(input, clear);

    const resultHeader = document.createElement("div");
    resultHeader.className = "catalog-result-header";
    const resultLabel = document.createElement("span");
    resultLabel.textContent = "Layers";
    const resultCount = document.createElement("span");
    resultCount.className = "catalog-result-count";
    resultHeader.append(resultLabel, resultCount);

    const results = document.createElement("div");
    results.id = "zartigl-catalog-results";
    results.className = "catalog-results";
    results.setAttribute("role", "listbox");

    const details = document.createElement("div");
    details.className = "catalog-details";

    picker.append(searchRow, resultHeader, results, details);
    addDomBlade(folder, picker);
    this.layerSearchInput = input;
    this.layerResultsEl = results;
    this.layerResultCountEl = resultCount;
    this.layerDetailsEl = details;

    input.addEventListener("input", () => {
      this.layerActiveIndex = 0;
      this.renderLayerPicker();
    });
    input.addEventListener("keydown", (event) => this.onLayerSearchKeyDown(event));
    clear.addEventListener("click", () => {
      input.value = "";
      input.focus();
      this.layerActiveIndex = 0;
      this.renderLayerPicker();
    });
    this.renderLayerPicker();
    this.buildSourceControls(folder);
  }

  private onLayerSearchKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.layerSearchInput.value = "";
      this.layerActiveIndex = 0;
      this.renderLayerPicker();
      return;
    }
    if (!this.layerResults.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.layerActiveIndex = (this.layerActiveIndex + delta + this.layerResults.length) % this.layerResults.length;
      this.renderLayerPicker();
      const active = this.layerResultsEl.children[this.layerActiveIndex] as HTMLElement | undefined;
      active?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const layer = this.layerResults[this.layerActiveIndex] ?? this.layerResults[0];
      if (layer) void this.switchLayer(layer);
    }
  }

  private renderLayerPicker(): void {
    if (!this.layerResultsEl) return;
    const query = this.layerSearchInput.value;
    this.layerResults = query.trim()
      ? searchCatalog(query, { locale: this.locale }, this.cat)
      : [...this.cat.layers];
    this.layerActiveIndex = this.layerResults.length
      ? Math.max(0, Math.min(this.layerActiveIndex, this.layerResults.length - 1))
      : -1;
    this.layerResultCountEl.textContent = `${this.layerResults.length}/${this.cat.layers.length}`;
    this.layerResultsEl.replaceChildren();

    if (!this.layerResults.length) {
      const empty = document.createElement("div");
      empty.className = "catalog-empty";
      empty.textContent = "No matching catalog layers.";
      this.layerResultsEl.appendChild(empty);
    }

    this.layerResults.forEach((entry, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "catalog-result";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(entry.id === this.currentLayer.id));
      item.classList.toggle("active", index === this.layerActiveIndex);
      item.classList.toggle("selected", entry.id === this.currentLayer.id);
      const title = document.createElement("span");
      title.className = "catalog-result-title";
      title.textContent = resolveLocalizedText(entry.title, this.locale, this.cat.defaultLocale);
      const meta = document.createElement("span");
      meta.className = "catalog-result-meta";
      meta.textContent = `${entry.category} · ${entry.kind} · ${entry.id}`;
      item.append(title, meta);
      item.title = resolveLocalizedText(entry.description, this.locale, this.cat.defaultLocale) || entry.id;
      item.addEventListener("mouseenter", () => {
        this.layerActiveIndex = index;
        for (const child of Array.from(this.layerResultsEl.children)) child.classList.remove("active");
        item.classList.add("active");
      });
      item.addEventListener("click", () => void this.switchLayer(entry));
      this.layerResultsEl.appendChild(item);
    });

    this.renderLayerDetails(this.currentLayer);
  }

  private renderLayerDetails(layer: CatalogEntry): void {
    this.layerDetailsEl.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "catalog-details-title";
    heading.textContent = resolveLocalizedText(layer.title, this.locale, this.cat.defaultLocale);
    this.layerDetailsEl.appendChild(heading);
    const description = resolveLocalizedText(layer.description, this.locale, this.cat.defaultLocale);
    if (description) {
      const text = document.createElement("div");
      text.className = "catalog-details-description";
      text.textContent = description;
      this.layerDetailsEl.appendChild(text);
    }
    const fields: [string, string][] = [["id", layer.id], ["category", layer.category], ["kind", layer.kind]];
    if (layer.aliases?.length) fields.push(["aliases", layer.aliases.join(", ")]);
    for (const source of layer.sources) {
      const provider = source.provenance?.provider;
      if (provider) fields.push(["provider", provider]);
      for (const [key, value] of Object.entries(source.provenance?.identifiers ?? {})) fields.push([key, value]);
      if (source.temporal?.mode) fields.push(["temporal", [source.temporal.mode, source.temporal.cadence].filter(Boolean).join(" · ")]);
      if (source.type === "zarr") {
        const vars = source.variables.kind === "scalar"
          ? [source.variables.value]
          : source.variables.derivation
            ? [source.variables.derivation.direction_variable, source.variables.derivation.magnitude_variable]
            : [source.variables.u, source.variables.v].filter((value): value is string => !!value);
        if (vars.length) fields.push(["variables", vars.join(", ")]);
      }
      fields.push(["source", source.type]);
    }
    const grid = document.createElement("div");
    grid.className = "catalog-details-grid";
    for (const [label, value] of fields) {
      const key = document.createElement("span");
      key.className = "catalog-details-label";
      key.textContent = label;
      const val = document.createElement("span");
      val.className = "catalog-details-value";
      val.textContent = value;
      grid.append(key, val);
    }
    this.layerDetailsEl.appendChild(grid);
  }

  private buildSourceControls(folder: FolderApi): void {
    const sourceContainer = document.createElement("div");
    this.sourceSelectEl = document.createElement("select");
    this.sourceSelectEl.className = "source-select";
    sourceContainer.appendChild(this.sourceSelectEl);

    this.sourceBlade = addDomBlade(folder, sourceContainer);
    this.sourceBlade.hidden = this.currentLayer.sources.length <= 1;
    this.renderSourceSelect();
    this.sourceSelectEl.addEventListener("change", () => {
      const source = this.currentLayer.sources.find((candidate) => candidate.id === this.sourceSelectEl.value);
      if (source) void this.switchSource(source);
    });
  }

  private buildDisplayFolder(): void {
    const folder = this.pane.addFolder({ title: "Display", expanded: false });

    const projContainer = document.createElement("div");
    projContainer.className = "projection-buttons";

    for (const proj of ["mercator", "globe"] as const) {
      const btn = document.createElement("button");
      btn.textContent = proj;
      btn.className = "projection-button" + (proj === this.currentProjection ? " active" : "");
      btn.addEventListener("click", () => {
        this.currentProjection = proj;
        this.map.setProjection({ type: proj });
        for (const e of this.projButtons) {
          e.btn.classList.toggle("active", e.proj === proj);
        }
      });
      this.projButtons.push({ proj, btn });
      projContainer.appendChild(btn);
    }

    addDomBlade(folder, projContainer);

    const paletteSelect = document.createElement("select");
    paletteSelect.className = "palette-select";
    for (const p of getPalettes()) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      paletteSelect.appendChild(opt);
    }
    paletteSelect.value = this.params.palette;
    paletteSelect.addEventListener("change", () => {
      this.params.palette = paletteSelect.value;
      this.z?.updateSettings({ palette: paletteSelect.value });
      this.syncLegend();
      setTimeout(() => this.syncLegend(), 400);
    });
    addDomBlade(folder, paletteSelect);
    this.paletteSelectEl = paletteSelect;

    // Legend DOM (gradient + image, toggled by syncLegend)
    const legendWrapper = document.createElement("div");
    legendWrapper.className = "pane-legend";

    this.gradientSection = document.createElement("div");
    this.legendBar = document.createElement("div");
    this.legendBar.className = "legend-gradient-bar";
    const metaRow = document.createElement("div");
    metaRow.className = "legend-meta-row";
    this.legendMin = document.createElement("span");
    this.legendMin.className = "legend-min";
    this.legendUnit = document.createElement("span");
    this.legendUnit.className = "legend-unit";
    this.legendMax = document.createElement("span");
    this.legendMax.className = "legend-max";
    metaRow.append(this.legendMin, this.legendUnit, this.legendMax);
    this.gradientSection.append(this.legendBar, metaRow);

    this.legendImg = document.createElement("img");
    this.legendImg.className = "legend-img";
    this.legendImg.style.display = "none";

    legendWrapper.append(this.gradientSection, this.legendImg);
    addDomBlade(folder, legendWrapper);

    this.buildColorDomainControls(folder);

    folder.addBinding(this.params, "opacity", {
      min: 0, max: 1, step: 0.01, label: "opacity",
    }).on("change", (ev) => this.z?.updateSettings({ opacity: ev.value }));

    folder.addBinding(this.params, "logScale", { label: "log scale" })
      .on("change", (ev) => this.z?.updateSettings({ logScale: ev.value }));

    folder.addBinding(this.params, "vibrance", {
      min: -1, max: 1, step: 0.01, label: "vibrance",
    }).on("change", (ev) => this.z?.updateSettings({ vibrance: ev.value }));
  }

  private buildVectorFolder(): void {
    this.vectorFolder = this.pane.addFolder({ title: "Vector", expanded: false });

    this.vectorFolder.addBinding(this.params, "renderMode", {
      options: [
        { text: "Particles", value: "particles" },
        { text: "Raster", value: "raster" },
        { text: "Raster + particles", value: "raster+particles" },
      ],
      label: "mode",
    }).on("change", (ev) => this.z?.updateSettings({ renderMode: ev.value }));

    this.vectorFolder.addBinding(this.params, "particleDensity", {
      min: 0.001, max: 0.15, step: 0.001, label: "density",
    }).on("change", (ev) => this.z?.updateSettings({ particleDensity: ev.value }));

    this.vectorFolder.addBinding(this.params, "speed", {
      min: 0.1, max: 8, step: 0.1, label: "speed",
    }).on("change", (ev) => this.z?.updateSettings({ speed: ev.value }));

    this.vectorFolder.addBinding(this.params, "fade", {
      min: 0, max: 1, step: 0.01, label: "fade",
    }).on("change", (ev) => this.z?.updateSettings({ fade: ev.value }));
  }

  private buildExportFolder(): void {
    const folder = this.pane.addFolder({ title: "Export", expanded: false });
    folder.addButton({ title: "Copy MapX widget code" }).on("click", () => this.copyMapxWidgetSnippet());
    folder.addButton({ title: "Copy demo script/app" }).on("click", () => this.copyStandaloneDemoSnippet());
    folder.addButton({ title: "Copy debug info" }).on("click", () => this.copyDebugInfo());
    folder.addButton({ title: "Share URL" }).on("click", () => this.shareURL());
  }

  // ── Legend sync ─────────────────────────────────────────────────────

  private syncLegend(): void {
    if (!this.z) return;
    const legend = this.z.getLegend();
    const palettes = this.z.getPalettes();

    if (legend.type === "image") {
      this.gradientSection.style.display = "none";
      this.legendImg.src = legend.url;
      this.legendImg.style.display = "";
      if (this.paletteSelectEl) this.paletteSelectEl.disabled = true;
    } else if (legend.type === "gradient") {
      this.legendImg.style.display = "none";
      this.gradientSection.style.display = "";
      if (this.paletteSelectEl) this.paletteSelectEl.disabled = false;
      const palette = palettes.find((p) => p.id === legend.palette);
      if (palette) {
        this.legendBar.style.background =
          `linear-gradient(to right, ${palette.colors.join(", ")})`;
      }
      this.legendMin.textContent = legend.min?.toFixed(2) ?? "";
      this.legendMax.textContent = legend.max?.toFixed(2) ?? "";
      this.legendUnit.textContent = legend.unit ?? "";
    } else {
      this.gradientSection.style.display = "none";
      this.legendImg.style.display = "none";
      if (this.paletteSelectEl) this.paletteSelectEl.disabled = false;
    }
    this.syncColorDomainControl();
  }

  private buildColorDomainControls(folder: FolderApi): void {
    this.colorDomainMinBinding = folder.addBinding(this.params, "colorDomainMin", {
      label: "color min",
    }).on("change", () => {
      if (!this.syncingColorDomainControls) this.applyColorDomainBindings();
    }) as BindingApi;
    this.colorDomainMaxBinding = folder.addBinding(this.params, "colorDomainMax", {
      label: "color max",
    }).on("change", () => {
      if (!this.syncingColorDomainControls) this.applyColorDomainBindings();
    }) as BindingApi;
    this.colorDomainAutoButton = folder.addButton({ label: "color range", title: "Auto" })
      .on("click", () => this.resetColorDomain());
    this.colorDomainControls = [
      this.colorDomainMinBinding,
      this.colorDomainMaxBinding,
      this.colorDomainAutoButton,
    ];
    this.syncColorDomainVisibility();
  }

  private syncColorDomainVisibility(): void {
    if (this.colorDomainControls.length === 0) return;
    const visible = this.currentLayer.kind === "scalar" &&
      (this.currentBackend === "zarr" || this.z?.supportsDynamicStyle() === true);
    for (const control of this.colorDomainControls) control.hidden = !visible;
    if (this.paletteSelectEl) this.paletteSelectEl.disabled = this.z?.supportsDynamicStyle() === false;
  }

  private syncColorDomainControl(): void {
    if (this.colorDomainControls.length === 0) return;
    this.syncColorDomainVisibility();

    const domain = this.params.colorDomain ?? this.frameColorDomain;
    if (domain && domain.every(Number.isFinite)) {
      this.syncingColorDomainControls = true;
      try {
        this.params.colorDomainMin = domain[0];
        this.params.colorDomainMax = domain[1];
        this.colorDomainMinBinding.refresh();
        this.colorDomainMaxBinding.refresh();
      } finally {
        this.syncingColorDomainControls = false;
      }
    }
    this.colorDomainAutoButton.disabled = this.params.colorDomain == null;
  }

  private applyColorDomainBindings(): void {
    const min = this.params.colorDomainMin;
    const max = this.params.colorDomainMax;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      showToast("Color range requires min < max");
      this.syncColorDomainControl();
      return;
    }
    this.params.colorDomain = [min, max];
    this.z?.updateSettings({ colorDomain: this.params.colorDomain });
    this.syncLegend();
  }

  private resetColorDomain(): void {
    this.params.colorDomain = null;
    this.z?.updateSettings({ colorDomain: null });
    this.syncLegend();
  }

  // ── Map click query ─────────────────────────────────────────────────

  private async onMapClick(lngLat: LngLat): Promise<void> {
    if (!this.z || !this.z.getCapabilities().pointQuery) return;
    const z = this.z;
    this.activePopup?.remove();

    const layer = this.currentLayer;
    const depthAvailable = z.getDepthMeta().values.length > 1;
    const root = document.createElement("div");
    root.className = "query-popup";

    const header = document.createElement("div");
    header.className = "query-header";
    const title = document.createElement("strong");
    title.textContent = resolveLocalizedText(layer.title, this.locale, this.cat.defaultLocale);
    const coord = document.createElement("div");
    coord.className = "query-coord";
    coord.textContent = `${lngLat.lng.toFixed(3)}, ${lngLat.lat.toFixed(3)}`;
    header.append(title, coord);

    const modeRow = document.createElement("div");
    modeRow.className = "query-mode-row";
    const timeBtn = document.createElement("button");
    timeBtn.type = "button";
    timeBtn.textContent = "time";
    const depthBtn = document.createElement("button");
    depthBtn.type = "button";
    depthBtn.textContent = "depth";
    depthBtn.disabled = !depthAvailable;
    modeRow.append(timeBtn, depthBtn);

    const meta = document.createElement("div");
    meta.className = "query-meta";
    const chart = document.createElement("div");
    chart.className = "query-chart-host";
    root.append(header, modeRow, meta, chart);

    const popup = new maplibregl.Popup({ closeOnClick: true, maxWidth: "360px" })
      .setLngLat(lngLat)
      .setDOMContent(root)
      .addTo(this.map);
    this.activePopup = popup;

    const run = async (mode: PopupMode): Promise<void> => {
      const seq = ++this.pointQuerySeq;
      timeBtn.classList.toggle("active", mode === "time");
      depthBtn.classList.toggle("active", mode === "depth");
      meta.textContent = "";
      setPopupStatus(chart, "Loading samples...");

      try {
        const timeMeta = z.getTimeMeta();
        const currentMs = timeMeta.values?.[this.params.timeIndex] ?? timeMeta.current ?? timeMeta.max;
        const result = mode === "time"
          ? await z.queryTimeSeries({
              longitude: lngLat.lng,
              latitude: lngLat.lat,
              depth: this.params.depth,
              maxPoints: 96,
            })
          : await z.queryDepthProfile({
              longitude: lngLat.lng,
              latitude: lngLat.lat,
              time: currentMs,
              maxDepths: 48,
            });

        if (seq !== this.pointQuerySeq || !popup.isOpen()) return;

        const data = pointResultToData(result, layer);
        const unit = z.getVariableMeta().units ?? "";
        const nearest = nearestDatum(
          data,
          mode === "time" ? currentMs : this.params.depth,
          mode,
        );
        if (!nearest) {
          setPopupStatus(chart, "No data at this point.", "query-empty");
          return;
        }

        const vectorText = layer.kind === "vector"
          ? ` | u ${formatValue(nearest.u ?? NaN, unit)} / v ${formatValue(nearest.v ?? NaN, unit)}`
          : "";
        const depthText = result.depth != null
          ? ` | ${formatVertical(result.depth, z.getDepthMeta().label, z.getDepthMeta().units)}`
          : "";
        const timeText = mode === "depth" && result.time != null
          ? ` | ${formatTime(result.time)}`
          : "";
        meta.textContent =
          `source Zarr | grid ${result.longitude.toFixed(3)}, ${result.latitude.toFixed(3)}${depthText}${timeText}\n` +
          `value ${formatValue(nearest.value, unit)}${vectorText}`;
        renderPointChart(
          chart,
          data,
          mode,
          unit,
          z.getDepthMeta().label,
          z.getDepthMeta().units,
        );
      } catch (err) {
        if (seq !== this.pointQuerySeq || !popup.isOpen()) return;
        const msg = err instanceof Error ? err.message : String(err);
        setPopupStatus(chart, msg, "query-error");
      }
    };

    timeBtn.addEventListener("click", () => void run("time"));
    depthBtn.addEventListener("click", () => {
      if (depthAvailable) void run("depth");
    });

    await run(depthAvailable ? "depth" : "time");
  }

  // ── Export ──────────────────────────────────────────────────────────

  private copyMapxWidgetSnippet(): void {
    if (!this.z) return;
    const snippet = buildMapxWidgetSnippet(this.currentSnippetOptions());

    navigator.clipboard
      .writeText(snippet)
      .then(() => showToast("MapX widget code copied!"))
      .catch(() => showToast("Could not copy snippet."));
  }

  private copyStandaloneDemoSnippet(): void {
    if (!this.z) return;
    const center = this.map.getCenter();
    const snippet = buildStandaloneDemoSnippet({
      ...this.currentSnippetOptions(),
      center: [center.lng, center.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      projection: this.currentProjection,
    });

    navigator.clipboard
      .writeText(snippet)
      .then(() => showToast("Demo script copied!"))
      .catch(() => showToast("Could not copy snippet."));
  }

  private copyDebugInfo(): void {
    if (!this.z) return;

    navigator.clipboard
      .writeText(JSON.stringify(this.getDebugPayload(), null, 2))
      .then(() => showToast("Debug info copied!"))
      .catch(() => showToast("Could not copy debug info."));
  }

  private getDebugPayload(): {
    zartigl: ZartiglDebugInfo;
    demo: Record<string, unknown>;
  } {
    const center = this.map.getCenter();
    return {
      zartigl: this.z!.getDebugInfo(),
      demo: {
        fps: this.currentFps || null,
        url: location.href,
        projection: this.currentProjection,
        sourceType: this.currentBackend,
        layerId: this.currentLayer.id,
        layerTitle: resolveLocalizedText(this.currentLayer.title, this.locale, this.cat.defaultLocale),
        sourceId: this.currentSourceId,
        timeRange: this.currentTimeRange(),
        geoVideo: this.currentGeoVideoOptions(),
        center: [center.lng, center.lat],
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
      },
    };
  }

  private updateDebugStatus(): void {
    const info = this.z?.getDebugInfo();
    const delegate = info?.layer?.delegate;
    const simulation = delegate && "simulation" in delegate ? delegate.simulation : undefined;
    const renderer = this.shortRendererLabel(
      simulation?.webgl?.unmaskedRenderer ??
      simulation?.webgl?.renderer,
    );
    const fpsText = this.currentFps > 0 ? String(this.currentFps) : "--";
    const stateText = simulation
      ? [
          `state ${simulation.particleState}`,
          simulation.rgba8ParticlesSuppressed ? "raster-only" : "",
        ].filter(Boolean).join(" ")
      : "state --";
    const dpr = info?.devicePixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio : undefined);
    const videoFps = delegate?.kind === "scalar-geovideo" ? delegate.presentedFps : null;
    const fpsLabel = videoFps != null
      ? `video ${videoFps.toFixed(1)} FPS | UI ${fpsText}`
      : `FPS ${fpsText}`;
    this.fpsEl.textContent = [
      fpsLabel,
      stateText,
      dpr ? `DPR ${dpr}` : "",
      renderer,
    ].filter(Boolean).join(" | ");
  }

  private shortRendererLabel(renderer?: string): string {
    if (!renderer) return "";
    const parts = [
      renderer.match(/Intel/i)?.[0],
      renderer.match(/NVIDIA/i)?.[0],
      renderer.match(/AMD|Radeon/i)?.[0],
      renderer.match(/Apple/i)?.[0],
      renderer.match(/D3D11|Direct3D11|D3D9|Metal|OpenGL/i)?.[0],
    ].filter(Boolean);
    if (parts.length) return [...new Set(parts)].join(" ");
    return renderer.length > 28 ? `${renderer.slice(0, 25)}...` : renderer;
  }

  private currentSnippetOptions() {
    const layer = this.currentLayer;
    const timeMeta = this.z!.getTimeMeta();
    const depthMeta = this.z!.getDepthMeta();
    const timeMs = timeMeta.values?.[this.params.timeIndex] ?? timeMeta.current ?? timeMeta.max;
    return {
      layerId: layer.id,
      layerKind: layer.kind,
      source: this.currentSourceId,
      sourceType: this.currentBackend,
      time: new Date(timeMs),
      timeRange: this.currentTimeRange(),
      geoVideo: this.currentBackend === "geovideo" ? this.currentGeoVideoOptions() : undefined,
      depth: depthMeta.values.length > 0 ? this.params.depth : undefined,
      settings: this.buildSettings(),
    };
  }

  private shareURL(): void {
    if (!this.z) return;
    const timeMeta = this.z.getTimeMeta();
    const timeMs = timeMeta.values?.[this.params.timeIndex] ?? timeMeta.current ?? timeMeta.max;
    const center = this.map.getCenter();
    const state: HashState = {
      d: this.currentLayer.id,
      t: timeMs,
      v: this.params.depth,
      p: this.params.palette,
      s: this.currentSourceId,
      pr: this.currentProjection,
      c: [
        Number(center.lng.toFixed(6)),
        Number(center.lat.toFixed(6)),
      ],
      z: Number(this.map.getZoom().toFixed(3)),
      b: Number(this.map.getBearing().toFixed(3)),
      pi: Number(this.map.getPitch().toFixed(3)),
      pd: this.params.particleDensity,
      sp: this.params.speed,
      f: this.params.fade,
      rm: this.params.renderMode,
      op: this.params.opacity,
      ls: this.params.logScale,
      vb: this.params.vibrance,
      cd: this.params.colorDomain,
      tr: this.currentTimeRange()
        ? [this.params.allowedStart, this.params.allowedEnd]
        : undefined,
      ga: this.params.geoVideoAutoplay,
      gl: this.params.geoVideoLoop,
      gr: this.params.geoVideoPlaybackRate,
    };
    const hash = btoa(JSON.stringify(state));
    const url = `${location.origin}${location.pathname}#${hash}`;
    navigator.clipboard.writeText(url).then(() => showToast("URL copied!"));
  }

  // ── UI helpers ──────────────────────────────────────────────────────

  private updateLayerSelect(): void {
    this.renderLayerPicker();
  }

  private updateSourceVisibility(): void {
    if (this.sourceBlade) this.sourceBlade.hidden = this.currentLayer.sources.length <= 1;
    this.renderSourceSelect();
  }

  private renderSourceSelect(): void {
    if (!this.sourceSelectEl) return;
    this.sourceSelectEl.replaceChildren();
    for (const source of this.currentLayer.sources) {
      const label = source.type === "zarr" ? "Zarr" : source.type === "wmts" ? "WMTS" : "GeoVideo";
      const option = new Option(label, source.id);
      option.title = source.id;
      this.sourceSelectEl.appendChild(option);
    }
    this.sourceSelectEl.value = this.currentSourceId;
  }

  private applyHashCamera(hash: HashState | null): void {
    if (!hash) return;

    if (hash.pr === "mercator" || hash.pr === "globe") {
      this.currentProjection = hash.pr;
      this.map.setProjection({ type: hash.pr });
      for (const e of this.projButtons) {
        e.btn.classList.toggle("active", e.proj === hash.pr);
      }
    }

    const next: {
      center?: [number, number];
      zoom?: number;
      bearing?: number;
      pitch?: number;
    } = {};
    if (Array.isArray(hash.c) && hash.c.length === 2) {
      next.center = hash.c;
    }
    if (Number.isFinite(hash.z)) next.zoom = hash.z;
    if (Number.isFinite(hash.b)) next.bearing = hash.b;
    if (Number.isFinite(hash.pi)) next.pitch = hash.pi;

    if (Object.keys(next).length > 0) {
      this.map.jumpTo(next);
    }
  }

  // ── Params helpers ──────────────────────────────────────────────────

  private makeDefaultParams(): DemoParams {
    return {
      timeIndex: 0,
      timeLabel: "",
      allowedStart: 0,
      allowedEnd: 0,
      geoVideoAutoplay: false,
      geoVideoLoop: true,
      geoVideoPlaybackRate: 1,
      depth: 0,
      particleDensity: 0.05,
      speed: 1.0,
      fade: 0.7,
      renderMode: "particles",
      palette: "rdylbu",
      opacity: 1,
      logScale: false,
      vibrance: 0,
      colorDomain: null,
      colorDomainMin: 0,
      colorDomainMax: 1,
    };
  }

  private currentTimeRange(): { start: string; end: string } | undefined {
    const full = this.z?.getTimeMeta({ full: true });
    if (!full || (this.params.allowedStart === full.min && this.params.allowedEnd === full.max)) {
      return undefined;
    }
    return {
      start: new Date(this.params.allowedStart).toISOString(),
      end: new Date(this.params.allowedEnd).toISOString(),
    };
  }

  private currentGeoVideoOptions() {
    return {
      autoplay: this.params.geoVideoAutoplay,
      loop: this.params.geoVideoLoop,
      playbackRate: this.params.geoVideoPlaybackRate,
    };
  }

  private applyLayerDefaults(layer: CatalogEntry): void {
    const d = layer.defaults ?? {};
    this.params.particleDensity = d.particles?.density ?? 0.05;
    this.params.speed = d.particles?.speed ?? 1.0;
    this.params.fade = d.particles?.fade ?? 0.7;
    this.params.renderMode = layer.kind === "scalar"
      ? "raster"
      : (d.renderMode ?? "particles");
    this.params.opacity = d.raster?.opacity ?? 1;
    this.params.logScale = d.raster?.logScale ?? false;
    this.params.vibrance = d.raster?.vibrance ?? 0;
    this.params.colorDomain = d.raster?.colorDomain ?? null;
    this.params.colorDomainMin = this.params.colorDomain?.[0] ?? 0;
    this.params.colorDomainMax = this.params.colorDomain?.[1] ?? 1;
    this.params.palette = d.palette ?? "rdylbu";
  }

  private applyHashState(hash: HashState, layer: CatalogEntry): void {
    this.params.particleDensity = hash.pd;
    this.params.speed = hash.sp ?? 1.0;
    this.params.fade = hash.f ?? 0.7;
    this.params.renderMode = layer.kind === "scalar"
      ? "raster"
      : (hash.rm ?? this.params.renderMode);
    this.params.opacity = hash.op;
    this.params.logScale = hash.ls;
    this.params.vibrance = hash.vb;
    if (hash.cd !== undefined) {
      this.params.colorDomain = hash.cd;
      if (hash.cd) {
        this.params.colorDomainMin = hash.cd[0];
        this.params.colorDomainMax = hash.cd[1];
      }
    }
    this.params.palette = hash.p;
  }

  private buildSettings(): Partial<ZartiglSettings> {
    return {
      palette: this.params.palette,
      particleDensity: this.params.particleDensity,
      speed: this.params.speed,
      fade: this.params.fade,
      renderMode: this.params.renderMode,
      opacity: this.params.opacity,
      logScale: this.params.logScale,
      vibrance: this.params.vibrance,
      colorDomain: this.params.colorDomain,
    };
  }

  private loadHashState(): HashState | null {
    const hash = location.hash.slice(1);
    if (!hash) return null;
    try {
      return JSON.parse(atob(hash)) as HashState;
    } catch {
      return null;
    }
  }
}
