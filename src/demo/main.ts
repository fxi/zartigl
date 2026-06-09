import maplibregl from "maplibre-gl";
import * as d3 from "d3";
import { Pane } from "tweakpane";
import type { BindingApi, FolderApi } from "@tweakpane/core";
import {
  ArcoLayer,
  ZarrSource,
  deriveDirectionMagnitudeComponents,
  getPalettes,
  getVectorDerivationVariables,
} from "../lib";
import type { FieldMeta, ZarrPointSeriesResult } from "../lib";
import { TimelinePlayer } from "../demo-shared/TimelinePlayer";
import { catalog, formatTime, formatVertical, getVerticalDim } from "../catalog";
import type { CatalogLayer, Catalog } from "../catalog";

// ── Hash state ───────────────────────────────────────────────────────

interface HashState {
  d: number;    // layer index
  t: number;    // time ms
  v: number;    // vertical value
  p: string;    // palette id
  s?: "zarr" | "wmts"; // scalar source
  pd: number;   // particleDensity
  sm: number;   // speedMin
  sx: number;   // speedMax
  fm: number;   // fadeMin
  fx: number;   // fadeMax
  dr: number;   // dropRate
  db: number;   // dropRateBump
  op: number;   // opacity
  ls: boolean;  // logScale
  vb: number;   // vibrance
}

function loadHashState(): HashState | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  try {
    return JSON.parse(atob(hash)) as HashState;
  } catch {
    return null;
  }
}

async function loadCatalog(): Promise<Catalog> {
  return catalog;
}

// ── Helpers ──────────────────────────────────────────────────────────

function showToast(msg: string) {
  const t = document.createElement("div");
  t.className = "copy-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ── Map setup ────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: "map",
  style: `https://api.maptiler.com/maps/satellite-v4/style.json?key=${import.meta.env.MAPTILER_TOKEN}`,
  center: [0, 20],
  zoom: 2,
  maxZoom: 8,
});
(window as Window & { map?: maplibregl.Map }).map = map;

// ── Init ─────────────────────────────────────────────────────────────

map.on("load", async () => {
  try {
    const catalog = await loadCatalog();
    if (!catalog.layers.length) {
      console.error("No layers in catalog");
      return;
    }

    // ── Shared mutable state ───────────────────────────────────────

    let renderLayer: ArcoLayer = null!;
    let currentLayer: CatalogLayer;
    let dataFolderChildren: { dispose(): void }[] = [];
    let currentPaletteId = "rdylbu";
    let currentScalarSource: "zarr" | "wmts" = "zarr";

    let currentPlayer: TimelinePlayer | null = null;
    let playBtn: HTMLButtonElement | null = null;
    let timeLabelBinding: BindingApi;
    let timeSliderBinding: BindingApi;
    // Prevents the slider onChange from pausing the player when we update
    // PARAMS.timeIndex programmatically and call timeSliderBinding.refresh().
    // Tweakpane fires the change event whenever the bound value changes, even
    // on programmatic refresh, so we suppress it during player frame advances.
    let suppressSliderChange = false;

    // Pending hash state — consumed on first matching switchLayer call
    let pendingHashState = loadHashState();

    // DOM element refs — assigned when UI is built, used by refreshUI()
    let paletteSelectEl: HTMLSelectElement | null = null;
    let layerSelectEl: HTMLSelectElement | null = null;
    let sourceBtnContainer: HTMLDivElement | null = null;
    let sourceButtons: { source: "zarr" | "wmts"; btn: HTMLButtonElement }[] = [];
    let projectionButtons: { proj: string; btn: HTMLButtonElement }[] = [];
    let currentProjection: "mercator" | "globe" = "mercator";
    let pointSource: ZarrSource | null = null;
    let pointSourceUrl = "";
    let activePointPopup: maplibregl.Popup | null = null;
    let pointQuerySeq = 0;
    let hoverQuerySeq = 0;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;

    const PARAMS = {
      layerIndex: 0,
      timeIndex: 0,
      timeLabel: "",
      vertical: 0,
      particleDensity: 0.05,
      speedMin: 0.07,
      speedMax: 0.27,
      fadeMin: 0.9,
      fadeMax: 0.9315,
      dropRate: 0.003,
      dropRateBump: 0.01,
      opacity: 1.0,
      logScale: false,
      vibrance: 0.0,
    };

    const hoverReadout = document.createElement("div");
    hoverReadout.className = "hover-readout";
    hoverReadout.hidden = true;
    document.body.appendChild(hoverReadout);

    // ── Legend DOM (early init — needed by refreshUI) ──────────────

    const palettes = getPalettes();

    const legendGradientBar = document.createElement("div");
    legendGradientBar.className = "legend-gradient-bar";

    const legendMetaRow = document.createElement("div");
    legendMetaRow.className = "legend-meta-row";

    const legendMinLabel = document.createElement("span");
    legendMinLabel.className = "legend-min";
    legendMinLabel.textContent = "0";

    const legendUnitLabel = document.createElement("span");
    legendUnitLabel.className = "legend-unit";
    legendUnitLabel.textContent = "m/s";

    const legendMaxLabel = document.createElement("span");
    legendMaxLabel.className = "legend-max";
    legendMaxLabel.textContent = "";

    legendMetaRow.appendChild(legendMinLabel);
    legendMetaRow.appendChild(legendUnitLabel);
    legendMetaRow.appendChild(legendMaxLabel);

    const legendContainer = document.createElement("div");
    legendContainer.className = "pane-legend";
    legendContainer.appendChild(legendGradientBar);
    legendContainer.appendChild(legendMetaRow);

    function updateStandaloneLegendGradient() {
      const isWmts = currentLayer?.kind === "scalar" && currentScalarSource === "wmts";
      legendGradientBar.hidden = isWmts;
      legendMetaRow.hidden = isWmts;
      if (isWmts) return;
      const palette = palettes.find((p) => p.id === currentPaletteId);
      if (palette) {
        legendGradientBar.style.background = `linear-gradient(to right, ${palette.colors.join(", ")})`;
      }
    }

    function updateStandaloneLegendMeta(meta: FieldMeta) {
      legendMinLabel.textContent = meta.min.toFixed(2);
      legendMaxLabel.textContent = meta.max.toFixed(2);
      legendUnitLabel.textContent = meta.unit;
    }

    // ── Defaults / state helpers ───────────────────────────────────

    function applyDefaults(layer: CatalogLayer) {
      const d = layer.defaults ?? {};
      const speed = d.particles?.speedFactor;
      const fade = d.particles?.fadeOpacity;
      PARAMS.particleDensity = d.particles?.density ?? 0.05;
      PARAMS.speedMin = Array.isArray(speed) ? speed[0] : (speed ?? 0.07);
      PARAMS.speedMax = Array.isArray(speed) ? speed[1] : (speed ?? 0.27);
      PARAMS.fadeMin = Array.isArray(fade) ? fade[0] : (fade ?? 0.9);
      PARAMS.fadeMax = Array.isArray(fade) ? fade[1] : (fade ?? 0.9315);
      PARAMS.dropRate = d.particles?.dropRate ?? 0.003;
      PARAMS.dropRateBump = d.particles?.dropRateBump ?? 0.01;
      PARAMS.opacity = d.raster?.opacity ?? 1.0;
      PARAMS.logScale = d.raster?.logScale ?? false;
      PARAMS.vibrance = d.raster?.vibrance ?? 0.0;
      currentPaletteId = d.palette ?? "rdylbu";
    }

    function applyHashState(state: HashState) {
      PARAMS.particleDensity = state.pd;
      PARAMS.speedMin = state.sm;
      PARAMS.speedMax = state.sx;
      PARAMS.fadeMin = state.fm;
      PARAMS.fadeMax = state.fx;
      PARAMS.dropRate = state.dr;
      PARAMS.dropRateBump = state.db;
      PARAMS.opacity = state.op;
      PARAMS.logScale = state.ls;
      PARAMS.vibrance = state.vb;
      currentPaletteId = state.p;
      if (state.s) currentScalarSource = state.s;
    }

    function refreshUI() {
      if (paletteSelectEl) paletteSelectEl.value = currentPaletteId;
      if (paletteSelectEl) paletteSelectEl.disabled = currentLayer?.kind === "scalar" && currentScalarSource === "wmts";
      if (layerSelectEl) layerSelectEl.value = String(PARAMS.layerIndex);
      const canUseWmts = currentLayer?.kind === "scalar" && !!currentLayer.stores.wmts;
      if (sourceBtnContainer) sourceBtnContainer.style.display = canUseWmts ? "" : "none";
      for (const { source, btn } of sourceButtons) {
        btn.classList.toggle("active", source === currentScalarSource);
        btn.disabled = source === "wmts" && !canUseWmts;
      }
      for (const { proj, btn } of projectionButtons) {
        btn.classList.toggle("active", proj === currentProjection);
      }
      pane.refresh();
      updateStandaloneLegendGradient();
    }

    // ── Layer meta element (assigned when Layer folder is built) ─────

    let layerMetaEl: HTMLDivElement = null!;

    function updateInfo() {
      if (!layerMetaEl) return;
      const v = currentLayer;
      const metaStr = v.variables.standardName
        ? `${v.variables.standardName.replace(/_/g, " ")} — ${v.variables.units ?? ""}`
        : "";
      layerMetaEl.textContent = [v.description, metaStr].filter(Boolean).join("\n");
    }

    // ── Point popup time/depth charts ─────────────────────────────

    type PopupMode = "time" | "depth";
    type ChartDatum = {
      axis: number;
      value: number;
      time?: number;
      depth?: number;
      u?: number;
      v?: number;
    };

    function getCurrentTimeMs(): number {
      const timeDim = currentLayer.dimensions.time;
      return (timeDim.min ?? 0) + PARAMS.timeIndex * (timeDim.step ?? 21600000);
    }

    function getPointVariables(layer: CatalogLayer): string[] {
      if (layer.kind === "scalar") return [layer.variables.value ?? "scalar"];
      if (layer.variables.derivation) return getVectorDerivationVariables(layer.variables.derivation);
      return [layer.variables.u ?? "uo", layer.variables.v ?? "vo"];
    }

    function hasDepthProfile(layer: CatalogLayer): boolean {
      const vert = getVerticalDim(layer)?.[1];
      return (vert?.size ?? vert?.values?.length ?? 0) > 1;
    }

    function surfaceFirstDepthValues(values: number[]): number[] {
      return [...values].sort((a, b) => {
        const da = Math.abs(a);
        const db = Math.abs(b);
        if (da !== db) return da - db;
        return b - a;
      });
    }

    function getPointSource(layer: CatalogLayer): ZarrSource | null {
      if (!layer.stores.pointSeries?.url) return null;
      if (!pointSource || pointSourceUrl !== layer.stores.pointSeries?.url) {
        pointSource = new ZarrSource(layer.stores.pointSeries.url, 80);
        pointSourceUrl = layer.stores.pointSeries.url;
      }
      return pointSource;
    }

    function getTimeSampleWindow(layer: CatalogLayer, maxPoints = 96) {
      const timeDim = layer.dimensions.time;
      const size = timeDim.size ?? 1;
      const active = Math.max(0, Math.min(PARAMS.timeIndex, size - 1));
      const count = Math.min(maxPoints, size);
      let start = Math.max(0, active - Math.floor(count / 2));
      let end = Math.min(size - 1, start + count - 1);
      start = Math.max(0, end - count + 1);
      const stride = Math.max(1, Math.ceil((end - start + 1) / maxPoints));
      return { start, end, stride };
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

    function nearestDatum(data: ChartDatum[], mode: PopupMode): ChartDatum | null {
      const target = mode === "time" ? getCurrentTimeMs() : PARAMS.vertical;
      let best: ChartDatum | null = null;
      let bestDist = Infinity;
      for (const d of data) {
        const axis = mode === "time" ? (d.time ?? d.axis) : (d.depth ?? d.axis);
        const dist = Math.abs(axis - target);
        if (dist < bestDist) {
          best = d;
          bestDist = dist;
        }
      }
      return best;
    }

    function formatValue(v: number, unit: string): string {
      if (!Number.isFinite(v)) return "nodata";
      const abs = Math.abs(v);
      const text = abs >= 100 ? v.toFixed(1) : abs >= 10 ? v.toFixed(2) : v.toFixed(3);
      return unit ? `${text} ${unit}` : text;
    }

    function scheduleHoverReadout(lngLat: maplibregl.LngLat, point: maplibregl.Point) {
      if (hoverTimer !== null) clearTimeout(hoverTimer);
      if (currentLayer.kind !== "scalar") {
        hoverReadout.hidden = true;
        return;
      }
      hoverReadout.hidden = false;
      hoverReadout.style.left = `${Math.min(point.x + 14, window.innerWidth - 230)}px`;
      hoverReadout.style.top = `${Math.min(point.y + 14, window.innerHeight - 72)}px`;
      const seq = ++hoverQuerySeq;
      hoverTimer = setTimeout(async () => {
        if (!renderLayer) {
          hoverReadout.hidden = true;
          return;
        }
        try {
          const result = await renderLayer.samplePoint({
            longitude: lngLat.lng,
            latitude: lngLat.lat,
          });
          if (seq !== hoverQuerySeq || currentLayer.kind !== "scalar") return;
          if (!result) {
            hoverReadout.hidden = true;
            return;
          }
          const value = result.value;
          const unit = currentLayer.variables.units ?? "";
          const depthText = result.depth != null
            ? ` | ${formatVertical(result.depth, currentLayer.dimensions.vertical?.label ?? "depth")}`
            : "";
          hoverReadout.textContent =
            `${formatValue(value, unit)}\n` +
            `${result.longitude.toFixed(3)}, ${result.latitude.toFixed(3)}${depthText}`;
        } catch {
          if (seq === hoverQuerySeq) hoverReadout.textContent = "nodata";
        }
      }, 80);
    }

    function renderPointChart(
      host: HTMLElement,
      data: ChartDatum[],
      mode: PopupMode,
      unit: string,
    ) {
      host.replaceChildren();
      const finite = data.filter((d) => Number.isFinite(d.value));
      if (!finite.length) {
        const empty = document.createElement("div");
        empty.className = "timeseries-empty";
        empty.textContent = "No valid samples at this point.";
        host.appendChild(empty);
        return;
      }

      const width = 320;
      const height = 170;
      const margin = { top: 12, right: 14, bottom: 30, left: 44 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      const svg = d3
        .select(host)
        .append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("class", "timeseries-chart");

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      const valueExtent = d3.extent(finite, (d) => d.value) as [number, number];
      if (valueExtent[0] === valueExtent[1]) {
        valueExtent[0] -= 1;
        valueExtent[1] += 1;
      }

      if (mode === "time") {
        const xExtent = d3.extent(finite, (d) => d.time ?? d.axis) as [number, number];
        const x = d3.scaleTime()
          .domain([new Date(xExtent[0]), new Date(xExtent[1])])
          .range([0, innerW]);
        const y = d3.scaleLinear().domain(valueExtent).nice().range([innerH, 0]);
        const line = d3.line<ChartDatum>()
          .defined((d) => Number.isFinite(d.value))
          .x((d) => x(new Date(d.time ?? d.axis)))
          .y((d) => y(d.value));

        g.append("path").datum(data).attr("class", "timeseries-line").attr("d", line);
        g.append("g").attr("class", "timeseries-axis").attr("transform", `translate(0,${innerH})`)
          .call(d3.axisBottom(x).ticks(4).tickSizeOuter(0));
        g.append("g").attr("class", "timeseries-axis").call(d3.axisLeft(y).ticks(4).tickSizeOuter(0));
      } else {
        const depthExtent = d3.extent(finite, (d) => d.depth ?? d.axis) as [number, number];
        const x = d3.scaleLinear().domain(valueExtent).nice().range([0, innerW]);
        const y = d3.scaleLinear().domain(depthExtent).nice().range([0, innerH]);
        const line = d3.line<ChartDatum>()
          .defined((d) => Number.isFinite(d.value))
          .x((d) => x(d.value))
          .y((d) => y(d.depth ?? d.axis));

        g.append("path")
          .datum([...data].sort((a, b) => (a.depth ?? a.axis) - (b.depth ?? b.axis)))
          .attr("class", "timeseries-line")
          .attr("d", line);
        g.append("g").attr("class", "timeseries-axis").attr("transform", `translate(0,${innerH})`)
          .call(d3.axisBottom(x).ticks(4).tickSizeOuter(0));
        g.append("g").attr("class", "timeseries-axis").call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));
      }

      if (unit) {
        svg.append("text")
          .attr("class", "timeseries-unit-label")
          .attr("x", margin.left)
          .attr("y", height - 4)
          .text(unit);
      }
    }

    function setPopupStatus(body: HTMLElement, message: string, cls = "timeseries-loading") {
      body.replaceChildren();
      const status = document.createElement("div");
      status.className = cls;
      status.textContent = message;
      body.appendChild(status);
    }

    async function openPointPopup(lngLat: maplibregl.LngLat, initialMode: PopupMode = "time") {
      const source = getPointSource(currentLayer);
      if (!source) {
        showToast("No point time-series store for this layer");
        return;
      }

      currentPlayer?.pause();
      activePointPopup?.remove();

      const root = document.createElement("div");
      root.className = "timeseries-popup";

      const header = document.createElement("div");
      header.className = "timeseries-header";
      const title = document.createElement("div");
      title.className = "timeseries-title";
      title.textContent = currentLayer.label;
      const coord = document.createElement("div");
      coord.className = "timeseries-coord";
      coord.textContent = `${lngLat.lng.toFixed(3)}, ${lngLat.lat.toFixed(3)}`;
      header.append(title, coord);

      const modeRow = document.createElement("div");
      modeRow.className = "timeseries-mode-row";
      const timeBtn = document.createElement("button");
      timeBtn.type = "button";
      timeBtn.textContent = "time";
      const depthBtn = document.createElement("button");
      depthBtn.type = "button";
      depthBtn.textContent = "depth";
      const depthAvailable = hasDepthProfile(currentLayer);
      depthBtn.disabled = !depthAvailable;
      modeRow.append(timeBtn, depthBtn);

      const meta = document.createElement("div");
      meta.className = "timeseries-meta";
      const body = document.createElement("div");
      body.className = "timeseries-body";
      root.append(header, modeRow, meta, body);

      activePointPopup = new maplibregl.Popup({
        closeOnClick: false,
        maxWidth: "360px",
      })
        .setLngLat(lngLat)
        .setDOMContent(root)
        .addTo(map);

      const run = async (mode: PopupMode) => {
        const seq = ++pointQuerySeq;
        timeBtn.classList.toggle("active", mode === "time");
        depthBtn.classList.toggle("active", mode === "depth");
        setPopupStatus(body, "Loading samples...");

        try {
          const variables = getPointVariables(currentLayer);
          const timeMs = getCurrentTimeMs();
          const result = mode === "time"
            ? await source.sampleTimeSeries({
                variables,
                longitude: lngLat.lng,
                latitude: lngLat.lat,
                depth: PARAMS.vertical,
                ...(() => {
                  const window = getTimeSampleWindow(currentLayer);
                  return {
                    timeStartIndex: window.start,
                    timeEndIndex: window.end,
                    stride: window.stride,
                    stopAfterMissingSamples: 12,
                  };
                })(),
              })
            : await source.sampleVerticalProfile({
                variables,
                longitude: lngLat.lng,
                latitude: lngLat.lat,
                time: timeMs,
                stopAfterMissingSamples: 8,
              });

          if (seq !== pointQuerySeq || !activePointPopup?.isOpen()) return;

          const unit = currentLayer.variables.units ?? "";
          const data = pointResultToData(result, currentLayer);
          const current = nearestDatum(data, mode);
          const valueText = current ? formatValue(current.value, unit) : "nodata";
          const vectorText = currentLayer.kind === "vector" && current
            ? ` | u ${formatValue(current.u ?? NaN, unit)} / v ${formatValue(current.v ?? NaN, unit)}`
            : "";
          const depthText = result.depth != null ? ` | ${formatVertical(result.depth, currentLayer.dimensions.vertical?.label ?? "depth")}` : "";
          const timeText = mode === "depth" && result.time != null ? ` | ${formatTime(result.time)}` : "";
          meta.textContent =
            `grid ${result.longitude.toFixed(3)}, ${result.latitude.toFixed(3)}${depthText}${timeText}\n` +
            `value ${valueText}${vectorText}`;
          renderPointChart(body, data, mode, unit);
        } catch (err) {
          if (seq !== pointQuerySeq) return;
          const message = err instanceof Error ? err.message : String(err);
          setPopupStatus(body, message, "timeseries-error");
        }
      };

      timeBtn.addEventListener("click", () => run("time"));
      depthBtn.addEventListener("click", () => {
        if (depthAvailable) run("depth");
      });

      run(depthAvailable ? initialMode : "time");
    }

    // ── Tweakpane ─────────────────────────────────────────────────

    const pane = new Pane({ title: "zartigl", expanded: false });

    // Layer selector — grouped by category using optgroup
    if (catalog.layers.length > 1) {
      const layerFolder = pane.addFolder({ title: "Layer" }) as FolderApi;

      const layerSelect = document.createElement("select");
      layerSelect.className = "layer-select";

      // Collect categories in order of first appearance
      const seen = new Set<string>();
      const cats: string[] = [];
      for (const v of catalog.layers) {
        const cat = v.category ?? "Other";
        if (!seen.has(cat)) { seen.add(cat); cats.push(cat); }
      }

      if (cats.length > 1) {
        for (const cat of cats) {
          const grp = document.createElement("optgroup");
          grp.label = cat;
          catalog.layers.forEach((v, i) => {
            if ((v.category ?? "Other") !== cat) return;
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = v.label;
            grp.appendChild(opt);
          });
          layerSelect.appendChild(grp);
        }
      } else {
        catalog.layers.forEach((v, i) => {
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = v.label;
          layerSelect.appendChild(opt);
        });
      }

      layerSelect.value = String(PARAMS.layerIndex);
      layerSelect.addEventListener("change", () => {
        PARAMS.layerIndex = Number(layerSelect.value);
        switchLayer(catalog.layers[PARAMS.layerIndex]);
      });

      layerFolder.element.appendChild(layerSelect);
      layerSelectEl = layerSelect;

      const layerMetaDiv = document.createElement("div");
      layerMetaDiv.className = "layer-meta";
      layerFolder.element.appendChild(layerMetaDiv);
      layerMetaEl = layerMetaDiv;
    }

    // ── Data folder (rebuilt on layer switch) ────────────────────────

    const dataFolder = pane.addFolder({ title: "Data" }) as FolderApi;

    function rebuildDataFolder(catalogLayer: CatalogLayer) {
      for (const c of dataFolderChildren) c.dispose();
      dataFolderChildren = [];

      const timeDim = catalogLayer.dimensions.time;
      const timeMin = timeDim.min ?? 0;
      const timeStep = timeDim.step ?? 21600000;
      const timeSize = timeDim.size ?? 1;

      timeSliderBinding = dataFolder
        .addBinding(PARAMS, "timeIndex", {
          min: 0,
          max: timeSize - 1,
          step: 1,
          label: "time",
        })
        .on("change", (ev) => {
          if (suppressSliderChange) return;
          currentPlayer?.pause();
          const ms = timeMin + ev.value * timeStep;
          PARAMS.timeLabel = formatTime(ms);
          timeLabelBinding.refresh();
          renderLayer.setTime(ms);
          updateInfo();
        });

      timeLabelBinding = dataFolder.addBinding(PARAMS, "timeLabel", {
        readonly: true,
        label: "",
      }) as BindingApi;

      dataFolderChildren.push(timeSliderBinding, timeLabelBinding);

      if (!(catalogLayer.kind === "scalar" && currentScalarSource === "wmts")) {
        const playerContainer = document.createElement("div");
        playerContainer.className = "player-btns";
        const btn = document.createElement("button");
        btn.className = "player-btn";
        btn.textContent = "▶ play";
        playBtn = btn;

        // WMTS playback waits for the next visible tile set and crossfades it in.
        // Zarr scalar datasets can animate faster because frames are buffered as
        // decoded arrays instead of independent map tiles.
        // Vector datasets update the velocity field at 0.5 fps so the particle
        // animation continues uninterrupted between time steps.
        const isVector = catalogLayer.kind === "vector";
        const frameMs = isVector ? 2000 : 500;
        const bufferAhead = isVector ? 2 : 6;

        const player = new TimelinePlayer(renderLayer, PARAMS.timeIndex, {
          timeMin, timeStep, timeSize,
          bufferAhead,
          frameMs,
          bufferTimeoutMs: isVector ? 4000 : 1500,
        });
        currentPlayer = player;

        player.onStateChange = (state) => {
          if (!playBtn) return;
          if (state === "playing")   { playBtn.textContent = "⏸ pause"; playBtn.classList.add("playing"); }
          if (state === "paused")    { playBtn.textContent = "▶ play";  playBtn.classList.remove("playing"); }
          if (state === "buffering") { playBtn.textContent = "⏳ buffering…"; }
        };

        player.onFrameChange = (index, ms) => {
          PARAMS.timeIndex = index;
          PARAMS.timeLabel = formatTime(ms);
          suppressSliderChange = true;
          timeLabelBinding.refresh();
          timeSliderBinding.refresh();
          suppressSliderChange = false;
          updateInfo();
        };

        btn.addEventListener("click", () => {
          if (player.state === "paused") player.play();
          else player.pause();
        });

        playerContainer.appendChild(btn);
        dataFolder.element.appendChild(playerContainer);
        dataFolderChildren.push({
          dispose() {
            player.dispose();
            currentPlayer = null;
            playerContainer.remove();
            playBtn = null;
          }
        });
      }

      const vertEntry = getVerticalDim(catalogLayer);
      if (vertEntry) {
        const [, vertDim] = vertEntry;
        const vertLabel = catalogLayer.dimensions.vertical?.label ?? "depth";
        const vertValues = surfaceFirstDepthValues(vertDim.values ?? []);
        const vertOptions = vertValues.map((v) => ({
          text: formatVertical(v, vertLabel),
          value: v,
        }));

        const vertBinding = dataFolder
          .addBinding(PARAMS, "vertical", {
            options: vertOptions,
            label: vertLabel,
          })
          .on("change", (ev) => {
            renderLayer.setDepth(ev.value);
            updateInfo();
          });

        dataFolderChildren.push(vertBinding);
      }
    }

    // ── switchLayer ────────────────────────────────────────────────

    const layerEventHandlers: { onLoaded?: (meta: FieldMeta) => void } = {};

    function switchLayer(catalogLayer: CatalogLayer) {
      currentPlayer?.pause();
      pointQuerySeq++;
      activePointPopup?.remove();
      activePointPopup = null;
      if (map.getLayer("particles")) map.removeLayer("particles");

      const previousLayer = currentLayer;
      currentLayer = catalogLayer;
      if (!previousLayer || previousLayer.id !== catalogLayer.id || catalogLayer.kind !== "scalar" || !catalogLayer.stores.wmts) {
        currentScalarSource = "zarr";
      }

      const isScalar = catalogLayer.kind === "scalar";
      const timeDim = catalogLayer.dimensions.time;
      const timeMin = timeDim.min ?? 0;
      const timeStep = timeDim.step ?? 21600000;
      const vertEntry = getVerticalDim(catalogLayer);
      const vertValues = [...(vertEntry?.[1].values ?? [0])].sort(
        (a, b) => a - b,
      );

      const layerIdx = catalog.layers.indexOf(catalogLayer);
      if (pendingHashState && pendingHashState.d === layerIdx) {
        const hs = pendingHashState;
        applyHashState(hs);
        PARAMS.timeIndex = Math.max(
          0,
          Math.min(
            Math.round((hs.t - timeMin) / timeStep),
            (timeDim.size ?? 1) - 1,
          ),
        );
        PARAMS.timeLabel = formatTime(timeMin + PARAMS.timeIndex * timeStep);
        PARAMS.vertical = vertValues.includes(hs.v)
          ? hs.v
          : (vertValues[0] ?? 0);
        pendingHashState = null;
      } else {
        applyDefaults(catalogLayer);
        PARAMS.timeIndex = (timeDim.size ?? 1) - 1;
        PARAMS.timeLabel = formatTime(timeMin + PARAMS.timeIndex * timeStep);
        PARAMS.vertical = vertValues[0] ?? 0;
      }

      renderLayer = new ArcoLayer({
        id: "particles",
        layer: catalogLayer,
        backend: isScalar && currentScalarSource === "wmts" ? "wmts" : "zarr",
        time: timeMin + PARAMS.timeIndex * timeStep,
        depth: PARAMS.vertical,
        particleDensity: PARAMS.particleDensity,
        speedFactor: [PARAMS.speedMin, PARAMS.speedMax],
        fadeOpacity: [PARAMS.fadeMin, PARAMS.fadeMax],
        dropRate: PARAMS.dropRate,
        dropRateBump: PARAMS.dropRateBump,
        opacity: PARAMS.opacity,
        logScale: PARAMS.logScale,
        vibrance: PARAMS.vibrance,
      });

      if (layerEventHandlers.onLoaded) {
        renderLayer.on("loaded", layerEventHandlers.onLoaded);
      }

      map.addLayer(renderLayer);
      renderLayer.setColorRamp(currentPaletteId);
      rebuildDataFolder(catalogLayer);

      const hide = isScalar ? "none" : "";
      particlesFolder.element.style.display = hide;
      motionFolder.element.style.display = hide;
      trailFolder.element.style.display = hide;

      updateInfo();
      refreshUI();
    }

    // ── Particles folder ──────────────────────────────────────────

    const particlesFolder = pane.addFolder({ title: "Particles" });
    particlesFolder
      .addBinding(PARAMS, "particleDensity", {
        min: 0.001,
        max: 0.15,
        step: 0.001,
        label: "density",
      })
      .on("change", (ev) => renderLayer.setParticleDensity(ev.value));

    // ── Motion folder ─────────────────────────────────────────────

    const motionFolder = pane.addFolder({ title: "Motion" });
    motionFolder
      .addBinding(PARAMS, "speedMin", {
        min: 0.01,
        max: 2,
        step: 0.01,
        label: "speed (local)",
      })
      .on("change", () =>
        renderLayer.setSpeedFactor([PARAMS.speedMin, PARAMS.speedMax]),
      );
    motionFolder
      .addBinding(PARAMS, "speedMax", {
        min: 0.01,
        max: 2,
        step: 0.01,
        label: "speed (global)",
      })
      .on("change", () =>
        renderLayer.setSpeedFactor([PARAMS.speedMin, PARAMS.speedMax]),
      );
    motionFolder
      .addBinding(PARAMS, "dropRate", {
        min: 0,
        max: 0.1,
        step: 0.001,
        label: "drop rate",
      })
      .on("change", (ev) => renderLayer.setDropRate(ev.value));
    motionFolder
      .addBinding(PARAMS, "dropRateBump", {
        min: 0,
        max: 0.1,
        step: 0.001,
        label: "drop bump",
      })
      .on("change", (ev) => renderLayer.setDropRateBump(ev.value));

    // ── Trail folder ──────────────────────────────────────────────

    const trailFolder = pane.addFolder({ title: "Trail" });
    trailFolder
      .addBinding(PARAMS, "fadeMin", {
        min: 0.9,
        max: 1,
        step: 0.0001,
        label: "fade (local)",
      })
      .on("change", () =>
        renderLayer.setFadeOpacity([PARAMS.fadeMin, PARAMS.fadeMax]),
      );
    trailFolder
      .addBinding(PARAMS, "fadeMax", {
        min: 0.9,
        max: 1,
        step: 0.0001,
        label: "fade (global)",
      })
      .on("change", () =>
        renderLayer.setFadeOpacity([PARAMS.fadeMin, PARAMS.fadeMax]),
      );

    // ── Initial layer (from hash or first) ─────────────────────────

    const initialIdx = Math.min(
      Math.max(pendingHashState?.d ?? 0, 0),
      catalog.layers.length - 1,
    );
    PARAMS.layerIndex = initialIdx;
    switchLayer(catalog.layers[initialIdx]);

    map.on("click", (ev) => {
      openPointPopup(ev.lngLat, "time");
    });
    map.on("mousemove", (ev) => {
      scheduleHoverReadout(ev.lngLat, ev.point);
    });
    map.on("mouseout", () => {
      hoverQuerySeq++;
      hoverReadout.hidden = true;
    });

    // ── Source / projection folder ────────────────────────────────

    const sourceFolder = pane.addFolder({ title: "Source" });

    sourceBtnContainer = document.createElement("div");
    sourceBtnContainer.className = "render-mode-btns";

    for (const source of ["zarr", "wmts"] as const) {
      const btn = document.createElement("button");
      btn.textContent = source;
      btn.className =
        "render-mode-btn" + (source === currentScalarSource ? " active" : "");
      btn.addEventListener("click", () => {
        if (source === "wmts" && !currentLayer.stores.wmts) return;
        currentScalarSource = source;
        switchLayer(currentLayer);
      });
      sourceButtons.push({ source, btn });
      sourceBtnContainer.appendChild(btn);
    }

    sourceFolder.element.appendChild(sourceBtnContainer);

    // ── Projection row (globe / mercator) ─────────────────────────

    const projBtnContainer = document.createElement("div");
    projBtnContainer.className = "render-mode-btns";

    for (const proj of ["mercator", "globe"] as const) {
      const btn = document.createElement("button");
      btn.textContent = proj;
      btn.className =
        "render-mode-btn" + (proj === currentProjection ? " active" : "");
      btn.addEventListener("click", () => {
        currentProjection = proj;
        map.setProjection({ type: proj });
        for (const entry of projectionButtons) {
          entry.btn.classList.toggle("active", entry.proj === proj);
        }
      });
      projectionButtons.push({ proj, btn });
      projBtnContainer.appendChild(btn);
    }

    sourceFolder.element.appendChild(projBtnContainer);

    // ── Palette folder ────────────────────────────────────────────

    const paletteFolder = pane.addFolder({ title: "Palette" });

    const paletteSelect = document.createElement("select");
    paletteSelect.className = "palette-select";
    for (const p of palettes) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === currentPaletteId) opt.selected = true;
      paletteSelect.appendChild(opt);
    }

    paletteSelect.addEventListener("change", () => {
      currentPaletteId = paletteSelect.value;
      renderLayer.setColorRamp(currentPaletteId);
      updateStandaloneLegendGradient();
    });

    paletteFolder.element.appendChild(paletteSelect);
    paletteFolder.element.appendChild(legendContainer);
    paletteSelectEl = paletteSelect;

    paletteFolder
      .addBinding(PARAMS, "opacity", { min: 0, max: 1, step: 0.01, label: "opacity" })
      .on("change", (ev) => renderLayer.setOpacity(ev.value));
    paletteFolder
      .addBinding(PARAMS, "vibrance", { min: -1, max: 1, step: 0.01, label: "vibrance" })
      .on("change", (ev) => renderLayer.setVibrance(ev.value));
    paletteFolder
      .addBinding(PARAMS, "logScale", { label: "log scale" })
      .on("change", (ev) => renderLayer.setLogScale(ev.value));

    // ── Export folder ─────────────────────────────────────────────

    const exportFolder = pane.addFolder({ title: "Export", expanded: false });

    exportFolder.addButton({ title: "Copy settings" }).on("click", () => {
      const isScalarV = currentLayer.kind === "scalar";
      const lines = [
        `  - id: ${currentLayer.id}`,
        `    palette: ${currentPaletteId}`,
      ];
      if (isScalarV && currentLayer.stores.wmts) {
        lines.push(`    source: ${currentScalarSource}`);
      }
      if (!isScalarV) {
        lines.push(
          `    particleDensity: ${PARAMS.particleDensity}`,
          `    speedMin: ${PARAMS.speedMin}`,
          `    speedMax: ${PARAMS.speedMax}`,
          `    fadeMin: ${PARAMS.fadeMin}`,
          `    fadeMax: ${PARAMS.fadeMax}`,
          `    dropRate: ${PARAMS.dropRate}`,
          `    dropRateBump: ${PARAMS.dropRateBump}`,
        );
      }
      lines.push(
        `    opacity: ${PARAMS.opacity}`,
        `    logScale: ${PARAMS.logScale}`,
        `    vibrance: ${PARAMS.vibrance}`,
      );
      navigator.clipboard.writeText(lines.join("\n")).then(() => showToast("Copied!"));
    });

    exportFolder.addButton({ title: "Share layer" }).on("click", () => {
      const v = catalog.layers[PARAMS.layerIndex];
      const timeMs =
        (v.dimensions.time.min ?? 0) +
        PARAMS.timeIndex * (v.dimensions.time.step ?? 21600000);
      const state: HashState = {
        d: PARAMS.layerIndex,
        t: timeMs,
        v: PARAMS.vertical,
        p: currentPaletteId,
        s: currentScalarSource,
        pd: PARAMS.particleDensity,
        sm: PARAMS.speedMin,
        sx: PARAMS.speedMax,
        fm: PARAMS.fadeMin,
        fx: PARAMS.fadeMax,
        dr: PARAMS.dropRate,
        db: PARAMS.dropRateBump,
        op: PARAMS.opacity,
        ls: PARAMS.logScale,
        vb: PARAMS.vibrance,
      };
      const hash = btoa(JSON.stringify(state));
      const url = `${window.location.origin}${window.location.pathname}#${hash}`;
      navigator.clipboard.writeText(url).then(() => showToast("URL copied!"));
    });

    // ── Wire legend ────────────────────────────────────────────────

    layerEventHandlers.onLoaded = updateStandaloneLegendMeta;
    renderLayer.on("loaded", updateStandaloneLegendMeta);
    refreshUI();
    updateStandaloneLegendGradient();

  } catch (err) {
    console.error("Failed to initialize:", err);
  }
});
