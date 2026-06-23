import type { Map as MaplibreMap, LngLat } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
import type { FolderApi, BindingApi } from "@tweakpane/core";
import {
  buildMapxWidgetSnippet,
  buildStandaloneDemoSnippet,
  Zartigl,
  deriveDirectionMagnitudeComponents,
  getPalettes,
} from "../lib";
import type {
  ParticleStateMode,
  RenderMode,
  ZarrPointSeriesResult,
  ZartiglDebugInfo,
  ZartiglSettings,
} from "../lib";
import { formatTime, formatVertical } from "../catalog";
import type { CatalogLayer, Catalog } from "../catalog";

// ── Types ─────────────────────────────────────────────────────────────

interface DemoParams {
  timeIndex: number;
  timeLabel: string;
  depth: number;
  particleDensity: number;
  speed: number;
  fade: number;
  renderMode: RenderMode;
  compatibilityMode: boolean;
  particleState: ParticleStateMode;
  rgba8MaxParticleZoom: number;
  palette: string;
  opacity: number;
  logScale: boolean;
  vibrance: number;
}

interface HashState {
  d: number;
  t: number;
  v: number;
  p: string;
  s?: "zarr" | "wmts";
  pr?: "mercator" | "globe";
  c?: [number, number];
  z?: number;
  b?: number;
  pi?: number;
  pd: number;
  sp?: number;
  f?: number;
  rm?: RenderMode;
  ps?: ParticleStateMode;
  rz?: number;
  op: number;
  ls: boolean;
  vb: number;
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

function getPointVariables(layer: CatalogLayer): string[] {
  if (layer.kind === "scalar") return [layer.variables.value];
  if (layer.variables.derivation) {
    return [
      layer.variables.derivation.direction_variable,
      layer.variables.derivation.magnitude_variable,
    ];
  }
  return [layer.variables.u ?? "uo", layer.variables.v ?? "vo"];
}

function nearestTimeIndex(values: readonly number[], target: number): number {
  if (values.length === 0) return 0;
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
  }
  return best;
}

function pointResultToData(
  result: ZarrPointSeriesResult,
  layer: CatalogLayer,
): ChartDatum[] {
  const variables = getPointVariables(layer);
  const isVector = layer.kind === "vector";

  return result.points.map((point) => {
    let u = point.values[variables[0]];
    let v = isVector ? point.values[variables[1]] : undefined;

    if (layer.variables.kind === "vector" && layer.variables.derivation) {
      const components = deriveDirectionMagnitudeComponents(
        point.values[layer.variables.derivation.direction_variable],
        point.values[layer.variables.derivation.magnitude_variable],
        layer.variables.derivation,
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
  private currentLayer: CatalogLayer;
  private currentBackend: "zarr" | "wmts" = "zarr";
  private currentProjection: "mercator" | "globe" = "mercator";
  private activePopup: maplibregl.Popup | null = null;
  private switchSeq = 0;
  private pointQuerySeq = 0;

  // Folder refs
  private dataFolder!: FolderApi;
  private particlesFolder!: FolderApi;
  private trailFolder!: FolderApi;
  private dataBindings: { dispose(): void }[] = [];

  // DOM refs
  private layerSelectEl!: HTMLSelectElement;
  private paletteSelectEl!: HTMLSelectElement;
  private layerDescEl!: HTMLDivElement;
  private sourceContainer!: HTMLDivElement;
  private sourceButtons: { source: "zarr" | "wmts"; btn: HTMLButtonElement }[] = [];
  private projButtons: { proj: string; btn: HTMLButtonElement }[] = [];
  private legendBar!: HTMLDivElement;
  private legendMin!: HTMLSpanElement;
  private legendMax!: HTMLSpanElement;
  private legendUnit!: HTMLSpanElement;
  private legendImg!: HTMLImageElement;
  private gradientSection!: HTMLDivElement;
  private fpsEl!: HTMLDivElement;
  private fpsFrameCount = 0;
  private fpsLastSample = 0;
  private currentFps = 0;
  private fpsRafId = 0;

  constructor(private readonly map: MaplibreMap, private readonly cat: Catalog) {
    const hash = this.loadHashState();
    const initialIdx = Math.max(0, Math.min(hash?.d ?? 0, cat.layers.length - 1));
    this.currentLayer = cat.layers[initialIdx];
    this.params = this.makeDefaultParams();

    this.pane = new Pane({ title: "zartigl", expanded: true });
    this.buildStaticUI();
    this.buildFpsCounter();
    this.startFpsCounter();
    this.applyHashCamera(hash);

    void this.switchLayer(this.currentLayer, hash);
    this.map.on("click", (ev) => void this.onMapClick(ev.lngLat));
  }

  // ── Layer switching ─────────────────────────────────────────────────

  async switchLayer(layer: CatalogLayer, hashState?: HashState | null): Promise<void> {
    const seq = ++this.switchSeq;
    this.pointQuerySeq++;

    this.activePopup?.remove();
    this.activePopup = null;

    if (hashState?.s === "wmts" && layer.kind === "scalar" && layer.stores.wmts) {
      this.currentBackend = "wmts";
    } else if (hashState?.s === "zarr") {
      this.currentBackend = "zarr";
    } else if (layer.kind !== "scalar" || !layer.stores.wmts) {
      this.currentBackend = "zarr";
    }

    // Apply params: layer defaults, then optional hash overrides
    this.applyLayerDefaults(layer);
    if (hashState) this.applyHashState(hashState);

    this.currentLayer = layer;

    this.z?.destroy();
    this.z = new Zartigl({
      id: "prod-zartigl",
      map: this.map,
      catalog: this.cat,
      backend: this.currentBackend,
      visible: true,
    });
    this.z.on("loaded", () => this.syncLegend());

    await this.z.setLayer(layer.id);
    if (seq !== this.switchSeq) return;

    const timeMeta = this.z.getTimeMeta();
    const depthMeta = this.z.getDepthMeta();
    const times = timeMeta.values ?? [];
    const tSize = times.length;

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
    this.particlesFolder.element.style.display = isVector ? "" : "none";
    this.trailFolder.element.style.display = isVector ? "" : "none";
    this.updateSourceVisibility();
    this.updateLayerDesc(layer);
    this.updateLayerSelect();

    if (this.paletteSelectEl) this.paletteSelectEl.value = this.params.palette;
    this.pane.refresh();

    setTimeout(() => this.syncLegend(), 400);
  }

  // ── Data UI (rebuilt per layer) ─────────────────────────────────────

  private rebuildDataUI(): void {
    for (const b of this.dataBindings) b.dispose();
    this.dataBindings = [];

    const timeMeta = this.z!.getTimeMeta();
    const times = timeMeta.values ?? [];
    const tSize = times.length;

    let labelBinding: BindingApi;

    const sliderBinding = this.dataFolder.addBinding(this.params, "timeIndex", {
      min: 0,
      max: Math.max(0, tSize - 1),
      step: 1,
      label: "time",
    }).on("change", (ev) => {
      const ms = times[ev.value];
      this.params.timeLabel = formatTime(ms);
      labelBinding.refresh();
      this.z?.setTime(ms);
    });

    labelBinding = this.dataFolder.addBinding(this.params, "timeLabel", {
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
      sliderBinding,
      labelBinding,
    );
    if (depthBinding) this.dataBindings.push(depthBinding);
  }

  // ── Static UI (built once) ──────────────────────────────────────────

  private buildStaticUI(): void {
    this.buildLayerFolder();
    this.dataFolder = this.pane.addFolder({ title: "Data" });
    this.buildSourceFolder();
    this.buildParticlesFolder();
    this.buildTrailFolder();
    this.buildAppearanceFolder();
    this.buildExportFolder();
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
    const folder = this.pane.addFolder({ title: "Layer" });

    const select = document.createElement("select");
    select.className = "layer-select";

    const seen = new Set<string>();
    const cats: string[] = [];
    for (const l of this.cat.layers) {
      const cat = l.category ?? "Other";
      if (!seen.has(cat)) { seen.add(cat); cats.push(cat); }
    }

    if (cats.length > 1) {
      for (const cat of cats) {
        const grp = document.createElement("optgroup");
        grp.label = cat;
        this.cat.layers.forEach((l, i) => {
          if ((l.category ?? "Other") !== cat) return;
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = l.label;
          grp.appendChild(opt);
        });
        select.appendChild(grp);
      }
    } else {
      this.cat.layers.forEach((l, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = l.label;
        select.appendChild(opt);
      });
    }

    select.value = String(this.cat.layers.indexOf(this.currentLayer));
    select.addEventListener("change", () => {
      const idx = Number(select.value);
      const layer = this.cat.layers[idx];
      if (layer) void this.switchLayer(layer);
    });

    folder.element.appendChild(select);
    this.layerSelectEl = select;

    const descDiv = document.createElement("div");
    descDiv.className = "layer-meta";
    folder.element.appendChild(descDiv);
    this.layerDescEl = descDiv;
  }

  private buildSourceFolder(): void {
    const folder = this.pane.addFolder({ title: "Source" });

    this.sourceContainer = document.createElement("div");
    this.sourceContainer.className = "render-mode-btns";

    for (const src of ["zarr", "wmts"] as const) {
      const btn = document.createElement("button");
      btn.textContent = src;
      btn.className = "render-mode-btn" + (src === this.currentBackend ? " active" : "");
      btn.addEventListener("click", () => {
        if (src === "wmts" && !this.currentLayer.stores.wmts) return;
        this.currentBackend = src;
        this.updateSourceButtons();
        void this.switchLayer(this.currentLayer);
      });
      this.sourceButtons.push({ source: src, btn });
      this.sourceContainer.appendChild(btn);
    }

    folder.element.appendChild(this.sourceContainer);

    const projContainer = document.createElement("div");
    projContainer.className = "render-mode-btns";

    for (const proj of ["mercator", "globe"] as const) {
      const btn = document.createElement("button");
      btn.textContent = proj;
      btn.className = "render-mode-btn" + (proj === this.currentProjection ? " active" : "");
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

    folder.element.appendChild(projContainer);
  }

  private buildParticlesFolder(): void {
    this.particlesFolder = this.pane.addFolder({ title: "Particles" });

    this.particlesFolder.addBinding(this.params, "renderMode", {
      options: [
        { text: "Particles", value: "particles" },
        { text: "Raster", value: "raster" },
        { text: "Raster + particles", value: "raster+particles" },
      ],
      label: "mode",
    }).on("change", (ev) => this.z?.updateSettings({ renderMode: ev.value }));

    this.particlesFolder.addBinding(this.params, "particleDensity", {
      min: 0.001, max: 0.15, step: 0.001, label: "density",
    }).on("change", (ev) => this.z?.updateSettings({ particleDensity: ev.value }));

    this.particlesFolder.addBinding(this.params, "speed", {
      min: 0.1, max: 8, step: 0.1, label: "speed",
    }).on("change", (ev) => this.z?.updateSettings({ speed: ev.value }));

    this.particlesFolder.addBinding(this.params, "compatibilityMode", {
      label: "compatibility mode",
    }).on("change", (ev) => {
      this.params.particleState = ev.value ? "rgba8" : "auto";
      this.z?.updateSettings({ particleState: this.params.particleState });
    });
  }

  private buildTrailFolder(): void {
    this.trailFolder = this.pane.addFolder({ title: "Trail" });

    this.trailFolder.addBinding(this.params, "fade", {
      min: 0, max: 1, step: 0.01, label: "fade",
    }).on("change", (ev) => this.z?.updateSettings({ fade: ev.value }));
  }

  private buildAppearanceFolder(): void {
    const folder = this.pane.addFolder({ title: "Appearance" });

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
    folder.element.appendChild(paletteSelect);
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
    folder.element.appendChild(legendWrapper);

    folder.addBinding(this.params, "opacity", {
      min: 0, max: 1, step: 0.01, label: "opacity",
    }).on("change", (ev) => this.z?.updateSettings({ opacity: ev.value }));

    folder.addBinding(this.params, "logScale", { label: "log scale" })
      .on("change", (ev) => this.z?.updateSettings({ logScale: ev.value }));

    folder.addBinding(this.params, "vibrance", {
      min: -1, max: 1, step: 0.01, label: "vibrance",
    }).on("change", (ev) => this.z?.updateSettings({ vibrance: ev.value }));
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
  }

  // ── Map click query ─────────────────────────────────────────────────

  private async onMapClick(lngLat: LngLat): Promise<void> {
    if (!this.z || !this.currentLayer.stores.pointSeries) return;
    const z = this.z;
    this.activePopup?.remove();

    const layer = this.currentLayer;
    const depthAvailable = z.getDepthMeta().values.length > 1;
    const root = document.createElement("div");
    root.className = "query-popup";

    const header = document.createElement("div");
    header.className = "query-header";
    const title = document.createElement("strong");
    title.textContent = layer.label;
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
          `grid ${result.longitude.toFixed(3)}, ${result.latitude.toFixed(3)}${depthText}${timeText}\n` +
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
        backend: this.currentBackend,
        layerId: this.currentLayer.id,
        layerLabel: this.currentLayer.label,
        center: [center.lng, center.lat],
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
      },
    };
  }

  private updateDebugStatus(): void {
    const info = this.z?.getDebugInfo();
    const simulation = info?.layer?.delegate?.simulation;
    const renderer = this.shortRendererLabel(
      simulation?.webgl?.unmaskedRenderer ??
      simulation?.webgl?.renderer,
    );
    const fpsText = this.currentFps > 0 ? String(this.currentFps) : "--";
    const stateText = simulation
      ? [
          `state ${simulation.particleState}`,
          simulation.particleStateMode === "rgba8" ? "compat" : "auto",
          simulation.rgba8ParticlesSuppressed ? "raster-only" : "",
        ].filter(Boolean).join(" ")
      : `state ${this.params.particleState}`;
    const dpr = info?.devicePixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio : undefined);
    this.fpsEl.textContent = [
      `FPS ${fpsText}`,
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
      backend: this.currentBackend,
      time: new Date(timeMs),
      depth: depthMeta.values.length > 0 ? this.params.depth : undefined,
      settings: this.buildSettings(),
    };
  }

  private shareURL(): void {
    if (!this.z) return;
    const layerIdx = this.cat.layers.indexOf(this.currentLayer);
    const timeMeta = this.z.getTimeMeta();
    const timeMs = timeMeta.values?.[this.params.timeIndex] ?? timeMeta.current ?? timeMeta.max;
    const center = this.map.getCenter();
    const state: HashState = {
      d: layerIdx,
      t: timeMs,
      v: this.params.depth,
      p: this.params.palette,
      s: this.currentBackend,
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
      ps: this.params.particleState,
      rz: this.params.rgba8MaxParticleZoom,
      op: this.params.opacity,
      ls: this.params.logScale,
      vb: this.params.vibrance,
    };
    const hash = btoa(JSON.stringify(state));
    const url = `${location.origin}${location.pathname}#${hash}`;
    navigator.clipboard.writeText(url).then(() => showToast("URL copied!"));
  }

  // ── UI helpers ──────────────────────────────────────────────────────

  private updateLayerSelect(): void {
    if (!this.layerSelectEl) return;
    const idx = this.cat.layers.indexOf(this.currentLayer);
    this.layerSelectEl.value = String(idx);
  }

  private updateLayerDesc(layer: CatalogLayer): void {
    if (!this.layerDescEl) return;
    const variableMeta = this.z?.getVariableMeta();
    const metaStr = variableMeta?.standardName
      ? `${variableMeta.standardName.replace(/_/g, " ")} — ${variableMeta.units ?? ""}`
      : "";
    this.layerDescEl.textContent = [layer.description, metaStr].filter(Boolean).join("\n");
  }

  private updateSourceVisibility(): void {
    const canWmts = this.currentLayer.kind === "scalar" && !!this.currentLayer.stores.wmts;
    if (this.sourceContainer) this.sourceContainer.style.display = canWmts ? "" : "none";
    this.updateSourceButtons();
  }

  private updateSourceButtons(): void {
    const canWmts = this.currentLayer.kind === "scalar" && !!this.currentLayer.stores.wmts;
    for (const { source, btn } of this.sourceButtons) {
      btn.classList.toggle("active", source === this.currentBackend);
      btn.disabled = source === "wmts" && !canWmts;
    }
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
      depth: 0,
      particleDensity: 0.05,
      speed: 1.0,
      fade: 0.7,
      renderMode: "particles",
      compatibilityMode: false,
      particleState: "auto",
      rgba8MaxParticleZoom: 4,
      palette: "rdylbu",
      opacity: 1,
      logScale: false,
      vibrance: 0,
    };
  }

  private applyLayerDefaults(layer: CatalogLayer): void {
    const d = layer.defaults ?? {};
    this.params.particleDensity = d.particles?.density ?? 0.05;
    this.params.speed = d.particles?.speed ?? 1.0;
    this.params.fade = d.particles?.fade ?? 0.7;
    this.params.renderMode = d.renderMode ?? "particles";
    this.params.compatibilityMode = false;
    this.params.particleState = "auto";
    this.params.rgba8MaxParticleZoom = 4;
    this.params.opacity = d.raster?.opacity ?? 1;
    this.params.logScale = d.raster?.logScale ?? false;
    this.params.vibrance = d.raster?.vibrance ?? 0;
    this.params.palette = d.palette ?? "rdylbu";
  }

  private applyHashState(hash: HashState): void {
    this.params.particleDensity = hash.pd;
    this.params.speed = hash.sp ?? 1.0;
    this.params.fade = hash.f ?? 0.7;
    this.params.renderMode = hash.rm ?? this.params.renderMode;
    this.params.particleState = hash.ps ?? this.params.particleState;
    this.params.compatibilityMode = this.params.particleState === "rgba8";
    this.params.rgba8MaxParticleZoom = hash.rz ?? this.params.rgba8MaxParticleZoom;
    this.params.opacity = hash.op;
    this.params.logScale = hash.ls;
    this.params.vibrance = hash.vb;
    this.params.palette = hash.p;
  }

  private buildSettings(): Partial<ZartiglSettings> {
    return {
      palette: this.params.palette,
      particleDensity: this.params.particleDensity,
      speed: this.params.speed,
      fade: this.params.fade,
      renderMode: this.params.renderMode,
      particleState: this.params.particleState,
      rgba8MaxParticleZoom: this.params.rgba8MaxParticleZoom,
      opacity: this.params.opacity,
      logScale: this.params.logScale,
      vibrance: this.params.vibrance,
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
