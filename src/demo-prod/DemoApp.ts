import type { Map as MaplibreMap, LngLat } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
import type { FolderApi, BindingApi, BladeApi } from "@tweakpane/core";
import {
  buildMapxWidgetSnippet,
  buildStandaloneDemoHtml,
  buildStandaloneDemoSnippet,
  Zartigl,
  deriveDirectionMagnitudeComponents,
  getPalettes,
  resolveTimeInputSelection,
} from "../lib";
import type {
  ZarrPointSeriesResult,
  ZartiglDebugInfo,
  ZartiglStatus,
  TimeGranularity,
} from "../lib";
import {
  diffStyle,
  formatTime,
  formatVertical,
  mergeStyles,
  resolveEntryStyle,
  resolveLocalizedText,
} from "../catalog";
import type { LayerStyleInput } from "../catalog";
import {
  backdropOf,
  hashStyle,
  patchedStyle,
  styleParams,
} from "./style-state";
import type { HashStyle, StyleParams } from "./style-state";
import type {
  CatalogEntry,
  Catalog,
  CatalogSource,
  CatalogSourcePreference,
  CatalogZarrSource,
} from "../catalog";
import { addCatalogPickerBlade } from "./CatalogPicker";
import type { CatalogPicker } from "./CatalogPicker";
import { addDomBlade, DomBladePlugin } from "./DomBladePlugin";
import {
  buildLimitedTimeRange,
  isoTimeRange,
  normalizeSharedTimeRange,
  exportedSnippetTime,
} from "./time-range";
import type { SharedTimeRange } from "./time-range";

// ── Types ─────────────────────────────────────────────────────────────

interface DemoParams extends StyleParams {
  timeIndex: number;
  timeLabel: string;
  allowedStart: number;
  allowedEnd: number;
  limitStart: boolean;
  limitEnd: boolean;
  pinTime: boolean;
  geoVideoAutoplay: boolean;
  geoVideoLoop: boolean;
  /** Time steps shown per second. */
  geoVideoStepsPerSecond: number;
  depth: number;
}

/** A share link; `st` is the style override, flat style keys are legacy. */
interface HashState extends HashStyle {
  d: string;
  t: number;
  v: number;
  s?: string;
  pr?: "mercator" | "globe";
  c?: [number, number];
  z?: number;
  b?: number;
  pi?: number;
  tr?: SharedTimeRange;
  pt?: boolean;
  ga?: boolean;
  gl?: boolean;
  /** Legacy playback-rate multiplier, read from older links only. */
  gr?: number;
  gs?: number;
}

type PopupMode = "time" | "depth";

const SOURCE_LABELS: Record<CatalogSource["type"], string> = {
  zarr: "Zarr",
  wmts: "WMTS",
  geovideo: "GeoVideo",
};

/** Whether a source preference applies to a catalog entry. */
function appliesTo(
  entry: CatalogEntry,
  preference: CatalogSourcePreference,
): boolean {
  return (
    preference === "auto" ||
    entry.sources.some(
      (source) => source.type === preference || source.id === preference,
    )
  );
}

/** Period of a fixed source, else its id. */
function sourcePeriod(source: CatalogSource): string {
  const { start, end } = source.temporal ?? {};
  return start
    ? `${start.slice(0, 10)} – ${(end ?? start).slice(0, 10)}`
    : source.id;
}

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
  if (!Number.isFinite(v)) {
    return "nodata";
  }
  const abs = Math.abs(v);
  const txt =
    abs >= 100 ? v.toFixed(1) : abs >= 10 ? v.toFixed(2) : v.toFixed(3);
  return unit ? `${txt} ${unit}` : txt;
}

function codeNumber(value: number, digits = 6): string {
  return String(Number(value.toFixed(digits)));
}

function zarrSource(layer: CatalogEntry): CatalogZarrSource {
  const configured = layer.defaults.querySourceId ?? layer.defaults.sourceId;
  const source =
    layer.sources.find(
      (candidate) => candidate.id === configured && candidate.type === "zarr",
    ) ??
    layer.sources.find(
      (candidate): candidate is CatalogZarrSource => candidate.type === "zarr",
    );
  if (!source || source.type !== "zarr") {
    throw new Error(`Catalog entry has no Zarr variables: ${layer.id}`);
  }
  return source;
}

function getPointVariables(layer: CatalogEntry): string[] {
  const variables = zarrSource(layer).variables;
  if (variables.kind === "scalar") {
    return [variables.value];
  }
  if (variables.derivation) {
    return [
      variables.derivation.direction_variable,
      variables.derivation.magnitude_variable,
    ];
  }
  return [variables.u ?? "uo", variables.v ?? "vo"];
}

function nearestTimeIndex(values: readonly number[], target: number): number {
  if (values.length === 0) {
    return 0;
  }
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) {
      best = i;
    }
  }
  return best;
}

function authoringInputType(
  granularity: TimeGranularity,
): "month" | "date" | "datetime-local" {
  if (granularity === "month") {
    return "month";
  }
  if (granularity === "day" || granularity === "year") {
    return "date";
  }
  return "datetime-local";
}

function authoringInputValue(
  time: number,
  granularity: TimeGranularity,
): string {
  const iso = new Date(time).toISOString();
  if (granularity === "year") {
    return iso.slice(0, 4);
  }
  if (granularity === "month") {
    return iso.slice(0, 7);
  }
  if (granularity === "day") {
    return iso.slice(0, 10);
  }
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
      ? Number.isFinite(u) && Number.isFinite(v)
        ? Math.hypot(u, v!)
        : NaN
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

function nearestDatum(
  data: ChartDatum[],
  target: number,
  mode: PopupMode,
): ChartDatum | null {
  let best: ChartDatum | null = null;
  let bestDist = Infinity;
  for (const datum of data) {
    const axis =
      mode === "time"
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

function setPopupStatus(
  body: HTMLElement,
  message: string,
  cls = "query-loading",
): void {
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

  const sx = (axis: number) =>
    margin.left + ((axis - axisMin) / axisSpan) * innerW;
  const sy = (value: number) =>
    margin.top +
    innerH -
    ((value - paddedMin) / (paddedMax - paddedMin || 1)) * innerH;
  const depthX = (value: number) =>
    margin.left + ((value - paddedMin) / (paddedMax - paddedMin || 1)) * innerW;
  const depthY = (axis: number) =>
    margin.top + ((axis - axisMin) / axisSpan) * innerH;

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

  const xMinLabel =
    mode === "time" ? formatTime(axisMin) : paddedMin.toPrecision(3);
  const xMaxLabel =
    mode === "time" ? formatTime(axisMax) : paddedMax.toPrecision(3);
  const yMinLabel =
    mode === "time"
      ? paddedMin.toPrecision(3)
      : formatVertical(axisMin, verticalLabel, verticalUnits);
  const yMaxLabel =
    mode === "time"
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
  /** Style override over the layer's own: what shares and exports. */
  private styleOverride: LayerStyleInput = {};
  private currentLayer: CatalogEntry;
  private currentBackend: "zarr" | "geovideo" | "wmts" = "zarr";
  /** Active source, which "auto" or a type preference may move. */
  private currentSourceId = "";
  /** Requested source: "auto", a source type, or a source id. */
  private sourcePreference: CatalogSourcePreference = "auto";
  private readonly locale = navigator.language || "en";
  private currentProjection: "mercator" | "globe" = "globe";
  private activePopup: maplibregl.Popup | null = null;
  private switchSeq = 0;
  private pointQuerySeq = 0;

  // Folder refs
  private timeFolder!: FolderApi;
  private layerFolder!: FolderApi;
  private vectorFolder!: FolderApi;
  private dataBindings: { dispose(): void }[] = [];
  /** Step and playback controls; playback is enabled on GeoVideo only. */
  private playbackBindings: { dispose(): void }[] = [];
  private playButton: HTMLButtonElement | null = null;
  private stepButtons: {
    previous: HTMLButtonElement;
    next: HTMLButtonElement;
  } | null = null;
  private dataStatusBlade!: BladeApi;
  private timeSliderBinding: BindingApi | null = null;
  private timeLabelBinding: BindingApi | null = null;
  private syncingVideoTimeControls = false;

  // DOM refs
  private layerPicker!: CatalogPicker;
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

  constructor(
    private readonly map: MaplibreMap,
    private readonly cat: Catalog,
  ) {
    const hash = this.loadHashState();
    this.currentLayer =
      cat.layers.find((entry) => entry.id === hash?.d) ?? cat.layers[0];
    this.params = this.makeDefaultParams();

    this.pane = new Pane({ title: "zartigl", expanded: true });
    this.pane.registerPlugin(DomBladePlugin);
    this.buildStaticUI();
    this.buildFpsCounter();
    this.startFpsCounter();
    this.map.setProjection({ type: this.currentProjection });
    this.applyHashCamera(hash);

    void this.switchLayer(this.currentLayer, hash);
    this.map.on("click", (ev) => void this.onMapClick(ev.lngLat));
  }

  // ── Layer switching ─────────────────────────────────────────────────

  async switchLayer(
    layer: CatalogEntry,
    hashState?: HashState | null,
  ): Promise<void> {
    const seq = ++this.switchSeq;
    this.pointQuerySeq++;
    this.frameColorDomain = null;

    this.activePopup?.remove();
    this.activePopup = null;

    // A shared link, else the current preference when the layer offers it.
    this.sourcePreference =
      [hashState?.s, this.sourcePreference].find(
        (preference): preference is CatalogSourcePreference =>
          preference != null && appliesTo(layer, preference),
      ) ?? "auto";

    const sharedTimeRange = normalizeSharedTimeRange(hashState?.tr);

    // Apply params: layer defaults, then optional hash overrides
    this.applyLayerDefaults(layer);
    if (hashState) {
      this.applyHashState(hashState, layer);
    }

    this.currentLayer = layer;

    this.z?.destroy();
    this.z = new Zartigl({
      id: "prod-zartigl",
      map: this.map,
      catalog: this.cat,
      layer: layer.id,
      source: this.sourcePreference,
      timeRange: sharedTimeRange,
      time: hashState?.t,
      depth: hashState?.v,
      style: this.styleOverride,
      geoVideo: {
        autoplay: hashState?.ga ?? this.params.geoVideoAutoplay,
        loop: hashState?.gl ?? this.params.geoVideoLoop,
        ...(hashState?.gs == null && hashState?.gr != null
          ? { playbackRate: hashState.gr }
          : {
              stepsPerSecond:
                hashState?.gs ?? this.params.geoVideoStepsPerSecond,
            }),
      },
      visible: true,
    });
    const activeZartigl = this.z;
    activeZartigl.on("loaded", (meta) => {
      if (this.z !== activeZartigl || seq !== this.switchSeq) {
        return;
      }
      if (layer.kind === "scalar") {
        this.frameColorDomain = [meta.min, meta.max];
      }
      this.syncLegend();
    });
    activeZartigl.on("sourceChange", () => {
      if (this.z === activeZartigl && seq === this.switchSeq) {
        this.syncActiveSource();
      }
    });
    activeZartigl.on("playbackChange", () => {
      if (this.z === activeZartigl && seq === this.switchSeq) {
        this.syncPlaybackControls();
      }
    });
    activeZartigl.on("status", (status) => {
      if (this.z === activeZartigl && seq === this.switchSeq) {
        this.updateDataStatus(status);
      }
    });
    let lastVideoUiUpdate = 0;
    activeZartigl.on("timeChange", (time) => {
      if (
        this.z !== activeZartigl ||
        seq !== this.switchSeq ||
        this.currentBackend !== "geovideo"
      ) {
        return;
      }
      const now = performance.now();
      if (now - lastVideoUiUpdate < 200) {
        return;
      }
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
      this.syncStepButtons();
    });

    await activeZartigl.init();
    if (seq !== this.switchSeq) {
      return;
    }
    const activeSource = activeZartigl.getSource();
    if (activeSource) {
      this.currentSourceId = activeSource.id;
      this.currentBackend = activeSource.type;
    }

    const timeMeta = this.z.getTimeMeta();
    const depthMeta = this.z.getDepthMeta();
    const times = timeMeta.values ?? [];
    const tSize = times.length;
    this.params.allowedStart = timeMeta.min;
    this.params.allowedEnd = timeMeta.max;
    this.params.geoVideoAutoplay =
      hashState?.ga ?? this.params.geoVideoAutoplay;
    this.params.geoVideoLoop = hashState?.gl ?? this.params.geoVideoLoop;
    this.params.geoVideoStepsPerSecond =
      hashState?.gs ?? this.params.geoVideoStepsPerSecond;

    if (hashState) {
      this.params.timeIndex = Math.max(
        0,
        Math.min(nearestTimeIndex(times, hashState.t), tSize - 1),
      );
      this.params.timeLabel = formatTime(times[this.params.timeIndex]);
      this.params.depth = depthMeta.values.includes(hashState.v)
        ? hashState.v
        : (depthMeta.values[0] ?? 0);
    } else {
      this.params.timeIndex = nearestTimeIndex(
        times,
        timeMeta.current ?? timeMeta.max,
      );
      this.params.timeLabel = formatTime(times[this.params.timeIndex]);
      this.params.depth = depthMeta.values[0] ?? 0;
    }

    this.rebuildDataUI();

    const isVector = layer.kind === "vector";
    this.vectorFolder.hidden = !isVector;
    this.updateSourceVisibility();
    this.syncColorDomainVisibility();
    this.updateLayerSelect();

    if (this.paletteSelectEl) {
      this.paletteSelectEl.value = this.params.palette;
    }
    this.pane.refresh();

    setTimeout(() => this.syncLegend(), 400);
  }

  private async switchSource(
    preference: CatalogSourcePreference,
  ): Promise<void> {
    if (!this.z || preference === this.sourcePreference) {
      return;
    }
    this.sourcePreference = preference;
    await this.z.update({ source: preference });
    const active = this.z.getSource();
    if (active) {
      this.currentSourceId = active.id;
      this.currentBackend = active.type;
    }
    const timeMeta = this.z.getTimeMeta();
    this.params.allowedStart = timeMeta.min;
    this.params.allowedEnd = timeMeta.max;
    this.params.timeIndex = nearestTimeIndex(
      timeMeta.values,
      timeMeta.current ?? timeMeta.max,
    );
    this.params.timeLabel = formatTime(timeMeta.values[this.params.timeIndex]);
    this.params.depth = this.z.getDepthMeta().current ?? 0;
    this.rebuildDataUI();
    this.renderSourceSelect();
    this.syncColorDomainVisibility();
    this.syncLegend();
  }

  // ── Data UI (rebuilt per layer) ─────────────────────────────────────

  private rebuildDataUI(): void {
    for (const b of this.dataBindings) {
      b.dispose();
    }
    this.dataBindings = [];
    this.timeSliderBinding = null;
    this.timeLabelBinding = null;

    const timeMeta = this.z!.getTimeMeta();
    const times = timeMeta.values ?? [];
    const tSize = times.length;

    this.timeSliderBinding = this.timeFolder
      .addBinding(this.params, "timeIndex", {
        min: 0,
        max: Math.max(0, tSize - 1),
        step: 1,
        label: "time",
      })
      .on("change", (ev) => {
        if (this.syncingVideoTimeControls) {
          return;
        }
        this.requestTime(times[ev.value]);
      }) as BindingApi;

    this.timeLabelBinding = this.timeFolder.addBinding(
      this.params,
      "timeLabel",
      {
        readonly: true,
        label: "",
      },
    ) as BindingApi;

    this.dataBindings.push(
      this.timeFolder.addBinding(this.params, "pinTime", {
        label: "pin in code",
      }) as BindingApi,
    );

    this.dataBindings.push(this.buildLimitRangeControls());

    const depthMeta = this.z!.getDepthMeta();
    let depthBinding: BindingApi | null = null;
    if (depthMeta.values.length > 0) {
      depthBinding = this.layerFolder
        .addBinding(this.params, "depth", {
          options: depthMeta.values.map((v) => ({
            text: formatVertical(v, depthMeta.label, depthMeta.units),
            value: v,
          })),
          label: depthMeta.label,
        })
        .on("change", (ev) => {
          void this.z?.update({ depth: ev.value });
          this.syncPlaybackControls();
        }) as BindingApi;
    }

    this.dataBindings.push(this.timeSliderBinding, this.timeLabelBinding);
    if (depthBinding) {
      this.dataBindings.push(depthBinding);
    }
    // The status stays last in Layer, below the depth rebuilt per layer.
    this.layerFolder.add(this.dataStatusBlade);
    this.rebuildPlaybackControls();
  }

  /**
   * Follow the source the facade shows, which a time or depth change can move
   * between Zarr and GeoVideo, so playback controls and shared links match.
   */
  private syncActiveSource(): void {
    const source = this.z?.getSource();
    if (!source || source.id === this.currentSourceId) {
      return;
    }
    this.currentSourceId = source.id;
    this.currentBackend = source.type;
    // The menu keeps the preference; "auto" names the source it shows.
    this.renderSourceSelect();
    // Leaves the time slider alone, which may be mid-drag; zartigl keeps the
    // selected depth across sources.
    this.rebuildPlaybackControls();
    this.syncColorDomainVisibility();
  }

  /** Show a time step: zartigl stops playback for any date change. */
  private requestTime(ms: number): void {
    this.params.timeLabel = formatTime(ms);
    this.timeLabelBinding?.refresh();
    void this.z?.update({ time: ms });
    this.syncPlaybackControls();
  }

  private step(offset: -1 | 1): void {
    const ms = this.z?.getSteppedTime(offset);
    if (ms === undefined) {
      return;
    }
    const values = this.z!.getTimeMeta().values;
    this.params.timeIndex = nearestTimeIndex(values, ms);
    this.syncingVideoTimeControls = true;
    try {
      this.timeSliderBinding?.refresh();
    } finally {
      this.syncingVideoTimeControls = false;
    }
    this.requestTime(ms);
  }

  /**
   * Step buttons on every source; play, loop and speed stay visible and are
   * disabled where zartigl cannot play.
   */
  private rebuildPlaybackControls(): void {
    for (const binding of this.playbackBindings) {
      binding.dispose();
    }
    this.playbackBindings = [];
    const state = this.z?.getPlaybackState();
    if (state) {
      this.params.geoVideoStepsPerSecond = state.stepsPerSecond;
    }

    const row = document.createElement("div");
    row.className = "playback-row";
    const button = (text: string, title: string, onClick: () => void) => {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = text;
      el.title = title;
      el.addEventListener("click", onClick);
      row.appendChild(el);
      return el;
    };
    const previous = button("⏮", "Previous step", () => this.step(-1));
    this.playButton = button("▶", "Play", () => {
      if (this.z?.getPlaybackState().playing) {
        this.z.pause();
      } else {
        void this.z?.play();
      }
    });
    const next = button("⏭", "Next step", () => this.step(1));
    this.stepButtons = { previous, next };

    const loop = this.timeFolder
      .addBinding(this.params, "geoVideoLoop", { label: "loop" })
      .on(
        "change",
        (event) => void this.z?.update({ geoVideo: { loop: event.value } }),
      );
    const rate = this.timeFolder
      .addBinding(this.params, "geoVideoStepsPerSecond", {
        label: "speed",
        options: (state?.speeds ?? []).map((value) => ({
          text: `${value} steps/s`,
          value,
        })),
      })
      .on(
        "change",
        (event) =>
          void this.z?.update({ geoVideo: { stepsPerSecond: event.value } }),
      );
    // Written into shared links and snippets; it never starts playback here.
    const autoplay = this.timeFolder.addBinding(
      this.params,
      "geoVideoAutoplay",
      { label: "autoplay in code" },
    );
    this.playbackBindings.push(
      addDomBlade(this.timeFolder, row),
      loop,
      rate,
      autoplay,
    );
    // Right below the date, whether the time controls were rebuilt too or
    // only the playback controls, after a source change.
    const at =
      this.timeFolder.children.indexOf(this.timeLabelBinding as BladeApi) + 1;
    this.playbackBindings.forEach((binding, index) =>
      this.timeFolder.add(binding as BladeApi, at + index),
    );
    this.syncPlaybackControls();
  }

  private syncPlaybackControls(): void {
    const state = this.z?.getPlaybackState();
    const disabled = !state?.available;
    if (this.playButton) {
      this.playButton.disabled = disabled;
      this.playButton.textContent = state?.playing ? "⏸" : "▶";
      this.playButton.title = state?.playing ? "Pause" : "Play";
    }
    this.syncStepButtons();
    // Loop, speed and autoplay follow the play button.
    for (const binding of this.playbackBindings.slice(1)) {
      (binding as BindingApi).disabled = disabled;
    }
  }

  /** Disable a step past the first or last time step. */
  private syncStepButtons(): void {
    if (this.stepButtons) {
      this.stepButtons.previous.disabled =
        this.z?.getSteppedTime(-1) === undefined;
      this.stepButtons.next.disabled = this.z?.getSteppedTime(1) === undefined;
    }
  }

  private buildLimitRangeControls(): BladeApi {
    const full = this.z!.getTimeMeta({ full: true });
    const group = document.createElement("div");
    group.className = "limit-range";
    const title = document.createElement("div");
    title.className = "limit-range-title";
    title.textContent = "Limit range";
    group.appendChild(title);

    const makeInput = (
      side: "start" | "end",
    ): HTMLInputElement | HTMLSelectElement => {
      const row = document.createElement("div");
      row.className = "limit-range-row";
      const label = document.createElement("label");
      label.className = "limit-range-toggle";
      const enabled =
        side === "start" ? this.params.limitStart : this.params.limitEnd;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = enabled;
      const labelText = document.createElement("span");
      labelText.textContent = side;
      label.append(checkbox, labelText);
      const input =
        full.granularity === "year"
          ? document.createElement("select")
          : document.createElement("input");
      if (input instanceof HTMLInputElement) {
        input.type = authoringInputType(full.granularity);
        input.min = authoringInputValue(full.min, full.granularity);
        input.max = authoringInputValue(full.max, full.granularity);
        input.step =
          full.granularity === "second"
            ? String(Math.max(1, (full.step ?? 1_000) / 1_000))
            : full.granularity === "minute" || full.granularity === "hour"
              ? String(Math.max(60, (full.step ?? 60_000) / 1_000))
              : "1";
      } else {
        const years = [
          ...new Set(
            full.values.map((time) => new Date(time).getUTCFullYear()),
          ),
        ];
        for (const year of years) {
          const option = document.createElement("option");
          option.value = String(year);
          option.textContent = String(year);
          input.appendChild(option);
        }
      }
      input.className = "limit-range-input";
      input.disabled = !enabled;
      input.value = authoringInputValue(
        side === "start" ? this.params.allowedStart : this.params.allowedEnd,
        full.granularity,
      );
      checkbox.addEventListener("change", () => {
        if (side === "start") {
          this.params.limitStart = checkbox.checked;
        } else {
          this.params.limitEnd = checkbox.checked;
        }
        void this.applyAuthoredRange();
      });
      input.addEventListener("change", () => {
        const snapped = resolveTimeInputSelection(
          full.values,
          input.value,
          full.granularity,
        );
        if (snapped === undefined) {
          return;
        }
        if (side === "start") {
          this.params.allowedStart = snapped;
          if (snapped > this.params.allowedEnd) {
            this.params.allowedEnd = snapped;
          }
        } else {
          this.params.allowedEnd = snapped;
          if (snapped < this.params.allowedStart) {
            this.params.allowedStart = snapped;
          }
        }
        void this.applyAuthoredRange();
      });
      row.append(label, input);
      group.appendChild(row);
      return input;
    };
    makeInput("start");
    makeInput("end");
    return addDomBlade(this.timeFolder, group);
  }

  private async applyAuthoredRange(): Promise<void> {
    if (!this.z) {
      return;
    }
    const z = this.z;
    const range = this.currentNumericTimeRange();
    await z.update({ timeRange: range ?? null });
    if (this.z !== z) {
      return;
    }
    const meta = z.getTimeMeta();
    this.params.allowedStart = meta.min;
    this.params.allowedEnd = meta.max;
    this.params.timeIndex = nearestTimeIndex(
      meta.values,
      meta.current ?? meta.min,
    );
    this.params.timeLabel = formatTime(meta.values[this.params.timeIndex]);
    this.rebuildDataUI();
  }

  // ── Static UI (built once) ──────────────────────────────────────────

  private buildStaticUI(): void {
    this.buildLayerFolder();
    this.dataStatusEl = document.createElement("div");
    this.dataStatusEl.className = "data-status";
    this.dataStatusEl.dataset.phase = "idle";
    this.dataStatusEl.textContent = "Idle";
    this.dataStatusBlade = addDomBlade(this.layerFolder, this.dataStatusEl);
    this.timeFolder = this.pane.addFolder({ title: "Time", expanded: true });
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
    this.layerFolder = folder;
    this.layerPicker = addCatalogPickerBlade(folder, {
      catalog: this.cat,
      locale: this.locale,
      selected: this.currentLayer,
      onSelect: (entry) => void this.switchLayer(entry),
    }).picker;
    this.buildSourceControls(folder);
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
      void this.switchSource(this.sourceSelectEl.value);
    });
  }

  private buildDisplayFolder(): void {
    const folder = this.pane.addFolder({ title: "Display", expanded: true });

    const projContainer = document.createElement("div");
    projContainer.className = "projection-buttons";

    for (const proj of ["mercator", "globe"] as const) {
      const btn = document.createElement("button");
      btn.textContent = proj;
      btn.className =
        "projection-button" +
        (proj === this.currentProjection ? " active" : "");
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
      this.patchStyle({ palette: paletteSelect.value });
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

    folder
      .addBinding(this.params, "opacity", {
        min: 0,
        max: 1,
        step: 0.01,
        label: "opacity",
      })
      .on("change", (ev) => this.patchStyle({ raster: { opacity: ev.value } }));

    folder
      .addBinding(this.params, "logScale", { label: "log scale" })
      .on("change", (ev) =>
        this.patchStyle({ raster: { logScale: ev.value } }),
      );

    folder
      .addBinding(this.params, "vibrance", {
        min: -1,
        max: 1,
        step: 0.01,
        label: "vibrance",
      })
      .on("change", (ev) =>
        this.patchStyle({ raster: { vibrance: ev.value } }),
      );
  }

  private buildVectorFolder(): void {
    this.vectorFolder = this.pane.addFolder({
      title: "Vector",
      expanded: false,
    });

    this.vectorFolder
      .addBinding(this.params, "renderMode", {
        options: [
          { text: "Particles", value: "particles" },
          { text: "Raster", value: "raster" },
          { text: "Raster + particles", value: "raster+particles" },
        ],
        label: "mode",
      })
      .on("change", (ev) => this.patchStyle({ renderMode: ev.value }));

    this.vectorFolder
      .addBinding(this.params, "particleDensity", {
        min: 0.001,
        max: 0.2,
        step: 0.001,
        label: "density",
      })
      .on("change", (ev) =>
        this.patchStyle({ particles: { density: ev.value } }),
      );

    this.vectorFolder
      .addBinding(this.params, "speed", {
        min: 0.1,
        max: 8,
        step: 0.1,
        label: "speed",
      })
      .on("change", (ev) =>
        this.patchStyle({ particles: { speed: ev.value } }),
      );

    this.vectorFolder
      .addBinding(this.params, "fade", {
        min: 0,
        max: 1,
        step: 0.01,
        label: "fade",
      })
      .on("change", (ev) => this.patchStyle({ particles: { fade: ev.value } }));

    this.vectorFolder
      .addBinding(this.params, "vibrant", { label: "vibrant" })
      .on("change", (ev) =>
        this.patchStyle({
          particles: { grade: ev.value ? "vibrant" : "off" },
        }),
      );

    // The backdrop is replaced as a whole: each control sends all of it.
    const patchBackdrop = () =>
      this.patchStyle({ particles: { backdrop: backdropOf(this.params) } });
    this.vectorFolder
      .addBinding(this.params, "backdropEnabled", { label: "backdrop" })
      .on("change", patchBackdrop);
    this.vectorFolder
      .addBinding(this.params, "backdropColor", { label: "backdrop color" })
      .on("change", patchBackdrop);
    this.vectorFolder
      .addBinding(this.params, "backdropOpacity", {
        min: 0,
        max: 1,
        step: 0.01,
        label: "backdrop opacity",
      })
      .on("change", patchBackdrop);
  }

  /** Patch the style override and show it. */
  private patchStyle(patch: LayerStyleInput): void {
    const next = patchedStyle(this.styleOverride, patch, this.currentLayer);
    if (next) {
      this.styleOverride = next;
      void this.z?.update({ style: next });
    }
  }

  private buildExportFolder(): void {
    const folder = this.pane.addFolder({ title: "Export", expanded: false });
    folder
      .addButton({ title: "Copy MapX widget code" })
      .on("click", () => this.copyMapxWidgetSnippet());
    folder
      .addButton({ title: "Copy demo script/app" })
      .on("click", () => this.copyStandaloneDemoSnippet());
    folder
      .addButton({ title: "Copy full demo HTML" })
      .on("click", () => this.copyStandaloneDemoHtml());
    folder
      .addButton({ title: "Copy debug info" })
      .on("click", () => this.copyDebugInfo());
    folder.addButton({ title: "Share URL" }).on("click", () => this.shareURL());
  }

  // ── Legend sync ─────────────────────────────────────────────────────

  private syncLegend(): void {
    if (!this.z) {
      return;
    }
    const legend = this.z.getLegend();
    const palettes = this.z.getPalettes();

    if (legend.type === "image") {
      this.gradientSection.style.display = "none";
      this.legendImg.src = legend.url;
      this.legendImg.style.display = "";
      if (this.paletteSelectEl) {
        this.paletteSelectEl.disabled = true;
      }
    } else if (legend.type === "gradient") {
      this.legendImg.style.display = "none";
      this.gradientSection.style.display = "";
      if (this.paletteSelectEl) {
        this.paletteSelectEl.disabled = false;
      }
      const palette = palettes.find((p) => p.id === legend.palette);
      if (palette) {
        this.legendBar.style.background = `linear-gradient(to right, ${palette.colors.join(
          ", ",
        )})`;
      }
      this.legendMin.textContent = legend.min?.toFixed(2) ?? "";
      this.legendMax.textContent = legend.max?.toFixed(2) ?? "";
      this.legendUnit.textContent = legend.unit ?? "";
    } else {
      this.gradientSection.style.display = "none";
      this.legendImg.style.display = "none";
      if (this.paletteSelectEl) {
        this.paletteSelectEl.disabled = false;
      }
    }
    this.syncColorDomainControl();
  }

  private buildColorDomainControls(folder: FolderApi): void {
    this.colorDomainMinBinding = folder
      .addBinding(this.params, "colorDomainMin", {
        label: "color min",
      })
      .on("change", () => {
        if (!this.syncingColorDomainControls) {
          this.applyColorDomainBindings();
        }
      }) as BindingApi;
    this.colorDomainMaxBinding = folder
      .addBinding(this.params, "colorDomainMax", {
        label: "color max",
      })
      .on("change", () => {
        if (!this.syncingColorDomainControls) {
          this.applyColorDomainBindings();
        }
      }) as BindingApi;
    this.colorDomainAutoButton = folder
      .addButton({ label: "color range", title: "Auto" })
      .on("click", () => this.resetColorDomain());
    this.colorDomainControls = [
      this.colorDomainMinBinding,
      this.colorDomainMaxBinding,
      this.colorDomainAutoButton,
    ];
    this.syncColorDomainVisibility();
  }

  private syncColorDomainVisibility(): void {
    if (this.colorDomainControls.length === 0) {
      return;
    }
    const visible =
      this.currentLayer.kind === "scalar" &&
      (this.currentBackend === "zarr" ||
        this.z?.supportsDynamicStyle() === true);
    for (const control of this.colorDomainControls) {
      control.hidden = !visible;
    }
    if (this.paletteSelectEl) {
      this.paletteSelectEl.disabled = this.z?.supportsDynamicStyle() === false;
    }
  }

  private syncColorDomainControl(): void {
    if (this.colorDomainControls.length === 0) {
      return;
    }
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
    this.patchStyle({ raster: { colorDomain: this.params.colorDomain } });
    this.syncLegend();
  }

  private resetColorDomain(): void {
    this.params.colorDomain = null;
    this.patchStyle({ raster: { colorDomain: null } });
    this.syncLegend();
  }

  // ── Map click query ─────────────────────────────────────────────────

  private async onMapClick(lngLat: LngLat): Promise<void> {
    if (!this.z || !this.z.getCapabilities().pointQuery) {
      return;
    }
    const z = this.z;
    this.activePopup?.remove();

    const layer = this.currentLayer;
    const depthAvailable = z.getDepthMeta().values.length > 1;
    const root = document.createElement("div");
    root.className = "query-popup";

    const header = document.createElement("div");
    header.className = "query-header";
    const title = document.createElement("strong");
    title.textContent = resolveLocalizedText(
      layer.title,
      this.locale,
      this.cat.defaultLocale,
    );
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

    const popup = new maplibregl.Popup({
      closeOnClick: true,
      maxWidth: "360px",
    })
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
        const currentMs =
          timeMeta.values?.[this.params.timeIndex] ??
          timeMeta.current ??
          timeMeta.max;
        const result =
          mode === "time"
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

        if (seq !== this.pointQuerySeq || !popup.isOpen()) {
          return;
        }

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

        const vectorText =
          layer.kind === "vector"
            ? ` | u ${formatValue(nearest.u ?? NaN, unit)} / v ${formatValue(
                nearest.v ?? NaN,
                unit,
              )}`
            : "";
        const depthText =
          result.depth != null
            ? ` | ${formatVertical(
                result.depth,
                z.getDepthMeta().label,
                z.getDepthMeta().units,
              )}`
            : "";
        const timeText =
          mode === "depth" && result.time != null
            ? ` | ${formatTime(result.time)}`
            : "";
        meta.textContent =
          `source Zarr | grid ${result.longitude.toFixed(
            3,
          )}, ${result.latitude.toFixed(3)}${depthText}${timeText}\n` +
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
        if (seq !== this.pointQuerySeq || !popup.isOpen()) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setPopupStatus(chart, msg, "query-error");
      }
    };

    timeBtn.addEventListener("click", () => void run("time"));
    depthBtn.addEventListener("click", () => {
      if (depthAvailable) {
        void run("depth");
      }
    });

    await run("time");
  }

  // ── Export ──────────────────────────────────────────────────────────

  private copyMapxWidgetSnippet(): void {
    if (!this.z) {
      return;
    }
    const snippet = buildMapxWidgetSnippet(this.currentSnippetOptions());

    navigator.clipboard
      .writeText(snippet)
      .then(() => showToast("MapX widget code copied!"))
      .catch(() => showToast("Could not copy snippet."));
  }

  private copyStandaloneDemoSnippet(): void {
    if (!this.z) {
      return;
    }
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

  private copyStandaloneDemoHtml(): void {
    if (!this.z) {
      return;
    }
    const center = this.map.getCenter();
    const html = buildStandaloneDemoHtml({
      ...this.currentSnippetOptions(),
      center: [center.lng, center.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      projection: this.currentProjection,
    });

    navigator.clipboard
      .writeText(html)
      .then(() => showToast("Full demo HTML copied!"))
      .catch(() => showToast("Could not copy HTML."));
  }

  private copyDebugInfo(): void {
    if (!this.z) {
      return;
    }

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
        layerTitle: resolveLocalizedText(
          this.currentLayer.title,
          this.locale,
          this.cat.defaultLocale,
        ),
        sourceId: this.currentSourceId,
        sourcePreference: this.sourcePreference,
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
    const simulation =
      delegate && "simulation" in delegate ? delegate.simulation : undefined;
    const renderer = this.shortRendererLabel(
      simulation?.webgl?.unmaskedRenderer ?? simulation?.webgl?.renderer,
    );
    const fpsText = this.currentFps > 0 ? String(this.currentFps) : "--";
    const stateText = simulation
      ? [
          `state ${simulation.particleState}`,
          simulation.rgba8ParticlesSuppressed ? "raster-only" : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "state --";
    const dpr =
      info?.devicePixelRatio ??
      (typeof window !== "undefined" ? window.devicePixelRatio : undefined);
    const videoFps =
      delegate?.kind === "scalar-geovideo" ? delegate.presentedFps : null;
    const fpsLabel =
      videoFps != null
        ? `video ${videoFps.toFixed(1)} FPS | UI ${fpsText}`
        : `FPS ${fpsText}`;
    this.fpsEl.textContent = [
      fpsLabel,
      stateText,
      dpr ? `DPR ${dpr}` : "",
      renderer,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  private shortRendererLabel(renderer?: string): string {
    if (!renderer) {
      return "";
    }
    const parts = [
      renderer.match(/Intel/i)?.[0],
      renderer.match(/NVIDIA/i)?.[0],
      renderer.match(/AMD|Radeon/i)?.[0],
      renderer.match(/Apple/i)?.[0],
      renderer.match(/D3D11|Direct3D11|D3D9|Metal|OpenGL/i)?.[0],
    ].filter(Boolean);
    if (parts.length) {
      return [...new Set(parts)].join(" ");
    }
    return renderer.length > 28 ? `${renderer.slice(0, 25)}...` : renderer;
  }

  private currentSnippetOptions() {
    const layer = this.currentLayer;
    const timeMeta = this.z!.getTimeMeta();
    const depthMeta = this.z!.getDepthMeta();
    const timeMs =
      timeMeta.values?.[this.params.timeIndex] ??
      timeMeta.current ??
      timeMeta.max;
    return {
      layerId: layer.id,
      layerKind: layer.kind,
      source: this.sourcePreference,
      sourceType: this.currentBackend,
      time: exportedSnippetTime(timeMs, this.params.pinTime),
      timeRange: this.currentTimeRange(),
      geoVideo: this.z?.getCapabilities().playback
        ? this.currentGeoVideoOptions()
        : undefined,
      depth: depthMeta.values.length > 0 ? this.params.depth : undefined,
      layerDefaults: layer.defaults,
      style: this.styleOverride,
    };
  }

  private shareURL(): void {
    if (!this.z) {
      return;
    }
    const timeMeta = this.z.getTimeMeta();
    const timeMs =
      timeMeta.values?.[this.params.timeIndex] ??
      timeMeta.current ??
      timeMeta.max;
    const center = this.map.getCenter();
    const state: HashState = {
      d: this.currentLayer.id,
      t: timeMs,
      v: this.params.depth,
      st: diffStyle(this.styleOverride, resolveEntryStyle(this.currentLayer)),
      s: this.sourcePreference,
      pr: this.currentProjection,
      c: [Number(center.lng.toFixed(6)), Number(center.lat.toFixed(6))],
      z: Number(this.map.getZoom().toFixed(3)),
      b: Number(this.map.getBearing().toFixed(3)),
      pi: Number(this.map.getPitch().toFixed(3)),
      tr: this.currentNumericTimeRange(),
      pt: this.params.pinTime,
      ga: this.params.geoVideoAutoplay,
      gl: this.params.geoVideoLoop,
      gs: this.params.geoVideoStepsPerSecond,
    };
    const hash = btoa(JSON.stringify(state));
    const url = `${location.origin}${location.pathname}#${hash}`;
    navigator.clipboard.writeText(url).then(() => showToast("URL copied!"));
  }

  // ── UI helpers ──────────────────────────────────────────────────────

  private updateLayerSelect(): void {
    this.layerPicker.setSelected(this.currentLayer);
  }

  private updateSourceVisibility(): void {
    if (this.sourceBlade) {
      this.sourceBlade.hidden = this.currentLayer.sources.length <= 1;
    }
    this.renderSourceSelect();
  }

  private renderSourceSelect(): void {
    if (!this.sourceSelectEl) {
      return;
    }
    const sources = this.currentLayer.sources;
    const types = [...new Set(sources.map((source) => source.type))];
    const options = [
      new Option(`auto (${SOURCE_LABELS[this.currentBackend]})`, "auto"),
      ...types.flatMap((type) => {
        const ofType = sources.filter((source) => source.type === type);
        // Several sources of one type (artifacts): each can be pinned too.
        const pinned =
          ofType.length > 1
            ? ofType.map((source) => {
                const option = new Option(
                  `${SOURCE_LABELS[type]} · ${sourcePeriod(source)}`,
                  source.id,
                );
                option.title = source.id;
                return option;
              })
            : [];
        return [new Option(SOURCE_LABELS[type], type), ...pinned];
      }),
    ];
    // An id from an older link, pinned to a type with a single source.
    if (!options.some((option) => option.value === this.sourcePreference)) {
      const source = sources.find((item) => item.id === this.sourcePreference);
      if (source) {
        options.push(
          new Option(`${SOURCE_LABELS[source.type]} · id`, source.id),
        );
      }
    }
    this.sourceSelectEl.replaceChildren(...options);
    this.sourceSelectEl.value = this.sourcePreference;
  }

  private applyHashCamera(hash: HashState | null): void {
    if (!hash) {
      return;
    }

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
    if (Number.isFinite(hash.z)) {
      next.zoom = hash.z;
    }
    if (Number.isFinite(hash.b)) {
      next.bearing = hash.b;
    }
    if (Number.isFinite(hash.pi)) {
      next.pitch = hash.pi;
    }

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
      limitStart: false,
      limitEnd: false,
      pinTime: false,
      geoVideoAutoplay: false,
      geoVideoLoop: true,
      geoVideoStepsPerSecond: 2,
      depth: 0,
      ...styleParams(resolveEntryStyle(this.currentLayer)),
    };
  }

  private currentTimeRange(): { start?: string; end?: string } | undefined {
    return isoTimeRange(this.currentNumericTimeRange());
  }

  private currentNumericTimeRange() {
    return buildLimitedTimeRange(
      this.params.allowedStart,
      this.params.allowedEnd,
      this.params.limitStart,
      this.params.limitEnd,
    );
  }

  private currentGeoVideoOptions() {
    return {
      autoplay: this.params.geoVideoAutoplay,
      loop: this.params.geoVideoLoop,
      stepsPerSecond: this.params.geoVideoStepsPerSecond,
    };
  }

  private applyLayerDefaults(layer: CatalogEntry): void {
    this.styleOverride = {};
    Object.assign(this.params, styleParams(resolveEntryStyle(layer)));
    this.params.limitStart = false;
    this.params.limitEnd = false;
    this.params.pinTime = false;
  }

  private applyHashState(hash: HashState, layer: CatalogEntry): void {
    const timeRange = normalizeSharedTimeRange(hash.tr);
    this.params.limitStart = timeRange?.start !== undefined;
    this.params.limitEnd = timeRange?.end !== undefined;
    this.params.pinTime = hash.pt === true;
    this.styleOverride = hashStyle(hash, layer.kind);
    Object.assign(
      this.params,
      styleParams(resolveEntryStyle(layer, this.styleOverride)),
    );
  }

  private loadHashState(): HashState | null {
    const hash = location.hash.slice(1);
    if (!hash) {
      return null;
    }
    try {
      return JSON.parse(atob(hash)) as HashState;
    } catch {
      return null;
    }
  }
}
