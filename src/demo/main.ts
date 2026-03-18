import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
import type { BindingApi, FolderApi } from "@tweakpane/core";
import { ParticleLayer, getPalettes } from "../lib/index.js";
import type { RenderMode } from "../lib/ParticleSimulation.js";
import type { FieldMeta } from "../lib/index.js";
import { TimelinePlayer } from "./TimelinePlayer.js";

// ── Catalog types ────────────────────────────────────────────────────

interface CatalogDimension {
  axis: string;
  size: number;
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
  chunk_size: number;
  units: string;
}

interface LayerDefaults {
  palette?: string;
  renderMode?: string;
  particleDensity?: number;
  speedMin?: number;
  speedMax?: number;
  fadeMin?: number;
  fadeMax?: number;
  dropRate?: number;
  dropRateBump?: number;
  opacity?: number;
  logScale?: boolean;
  vibrance?: number;
  selectedVariable?: string;
}

interface CatalogDataset {
  id: string;
  type: "vector" | "scalar";
  product: string;
  label: string;
  zarr_url: string;
  variables: Record<string, { standard_name: string; units: string }>;
  dimensions: Record<string, CatalogDimension>;
  vertical_label?: string;
  defaults?: LayerDefaults;
}

interface Catalog {
  generated: string;
  datasets: CatalogDataset[];
}

// ── Hash state ───────────────────────────────────────────────────────

interface HashState {
  d: number;    // dataset index
  t: number;    // time ms
  v: number;    // vertical value
  p: string;    // palette id
  rm: string;   // render mode
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
  const resp = await fetch(`${import.meta.env.BASE_URL}data/catalog.json`);
  if (!resp.ok) throw new Error(`Failed to load catalog: ${resp.status}`);
  return resp.json();
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatVertical(v: number, label: string): string {
  if (label === "pressure") return `${Math.round(v)} hPa`;
  if (v < 10) return `${v.toFixed(2)} m`;
  if (v < 100) return `${v.toFixed(1)} m`;
  return `${Math.round(v)} m`;
}

/** Return the [key, dim] entry for the z-axis dimension, if any. */
function getVerticalDim(
  dataset: CatalogDataset,
): [string, CatalogDimension] | undefined {
  return Object.entries(dataset.dimensions).find(([, d]) => d.axis === "z");
}

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
  style: {
    version: 8,
    sources: {
      "carto-dark": {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        ],
        tileSize: 256,
        attribution:
          '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      },
    },
    layers: [
      {
        id: "carto-dark",
        type: "raster",
        source: "carto-dark",
        minzoom: 0,
        maxzoom: 19,
      },
    ],
  },
  center: [0, 20],
  zoom: 2,
  maxZoom: 8,
});

// ── Init ─────────────────────────────────────────────────────────────

map.on("load", async () => {
  try {
    const catalog = await loadCatalog();
    if (!catalog.datasets.length) {
      console.error("No datasets in catalog");
      return;
    }

    // ── Shared mutable state ───────────────────────────────────────

    let layer: ParticleLayer = null!;
    let currentDataset: CatalogDataset;
    let dataFolderChildren: { dispose(): void }[] = [];
    let currentPaletteId = "rdylbu";
    let currentRenderMode: RenderMode = "raster+particles";

    let currentPlayer: TimelinePlayer | null = null;
    let playBtn: HTMLButtonElement | null = null;
    let timeLabelBinding: BindingApi;
    let timeSliderBinding: BindingApi;
    // Prevents the slider onChange from pausing the player when we update
    // PARAMS.timeIndex programmatically and call timeSliderBinding.refresh().
    // Tweakpane fires the change event whenever the bound value changes, even
    // on programmatic refresh, so we suppress it during player frame advances.
    let suppressSliderChange = false;

    // Pending hash state — consumed on first matching switchDataset call
    let pendingHashState = loadHashState();

    // DOM element refs — assigned when UI is built, used by refreshUI()
    let paletteSelectEl: HTMLSelectElement | null = null;
    let renderModeButtons: { mode: RenderMode; btn: HTMLButtonElement }[] = [];

    const PARAMS = {
      datasetIndex: 0,
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
      scalarVariable: "",
    };

    // ── Legend DOM (early init — needed by refreshUI) ──────────────

    const palettes = getPalettes();

    const standaloneLegend = document.createElement("div");
    standaloneLegend.id = "standalone-legend";

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
    standaloneLegend.appendChild(legendGradientBar);
    standaloneLegend.appendChild(legendMetaRow);
    document.body.appendChild(standaloneLegend);

    function updateStandaloneLegendGradient() {
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

    function applyDefaults(dataset: CatalogDataset) {
      const d = dataset.defaults ?? {};
      PARAMS.particleDensity = d.particleDensity ?? 0.05;
      PARAMS.speedMin = d.speedMin ?? 0.07;
      PARAMS.speedMax = d.speedMax ?? 0.27;
      PARAMS.fadeMin = d.fadeMin ?? 0.9;
      PARAMS.fadeMax = d.fadeMax ?? 0.9315;
      PARAMS.dropRate = d.dropRate ?? 0.003;
      PARAMS.dropRateBump = d.dropRateBump ?? 0.01;
      PARAMS.opacity = d.opacity ?? 1.0;
      PARAMS.logScale = d.logScale ?? false;
      PARAMS.vibrance = d.vibrance ?? 0.0;
      currentPaletteId = d.palette ?? "rdylbu";
      currentRenderMode = (d.renderMode as RenderMode) ?? "raster+particles";
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
      currentRenderMode = state.rm as RenderMode;
    }

    function refreshUI() {
      if (paletteSelectEl) paletteSelectEl.value = currentPaletteId;
      const isScalar = currentDataset?.type === "scalar";
      for (const { mode, btn } of renderModeButtons) {
        btn.classList.toggle("active", mode === currentRenderMode);
        btn.disabled = isScalar && mode !== "raster";
      }
      pane.refresh();
      updateStandaloneLegendGradient();
    }

    // ── Info panel ─────────────────────────────────────────────────

    const infoEl = document.getElementById("info")!;

    function updateInfo() {
      const ds = currentDataset;
      const vars = Object.entries(ds.variables)
        .map(([k, v]) => `${k} (${v.standard_name.replace(/_/g, " ")})`)
        .join(" + ");
      const units = Object.values(ds.variables)[0]?.units ?? "";
      const vertEntry = getVerticalDim(ds);
      const vertLabel = ds.vertical_label ?? "depth";
      const vertPart = vertEntry
        ? `  ${vertLabel[0].toUpperCase() + vertLabel.slice(1)}: ${formatVertical(PARAMS.vertical, vertLabel)}`
        : "";
      infoEl.textContent =
        `${ds.product}\n` +
        `${ds.label}\n` +
        `${vars} — ${units}\n` +
        `Time: ${PARAMS.timeLabel}${vertPart}`;
    }

    // ── Tweakpane ─────────────────────────────────────────────────

    const pane = new Pane({ title: "zartigl" });

    // Dataset selector (top-level, before Data folder)
    const datasetOptions = catalog.datasets.map((ds, i) => ({
      text: ds.label,
      value: i,
    }));
    if (datasetOptions.length > 1) {
      pane
        .addBinding(PARAMS, "datasetIndex", {
          options: datasetOptions,
          label: "dataset",
        })
        .on("change", (ev) => switchDataset(catalog.datasets[ev.value]));
    }

    // ── Data folder (rebuilt on dataset switch) ────────────────────

    const dataFolder = pane.addFolder({ title: "Data" }) as FolderApi;

    function rebuildDataFolder(dataset: CatalogDataset) {
      for (const c of dataFolderChildren) c.dispose();
      dataFolderChildren = [];

      const timeDim = dataset.dimensions.time;
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
          layer.setTime(ms);
          updateInfo();
        });

      timeLabelBinding = dataFolder.addBinding(PARAMS, "timeLabel", {
        readonly: true,
        label: "",
      }) as BindingApi;

      dataFolderChildren.push(timeSliderBinding, timeLabelBinding);

      // Play button only makes sense for scalar datasets — vector fields have
      // continuous particle animation and don't benefit from time stepping.
      if (dataset.type !== "vector") {
        const playerContainer = document.createElement("div");
        playerContainer.className = "player-btns";
        const btn = document.createElement("button");
        btn.className = "player-btn";
        btn.textContent = "▶ play";
        playBtn = btn;

        const player = new TimelinePlayer(layer, PARAMS.timeIndex, {
          timeMin, timeStep, timeSize,
          bufferAhead: 10,
          frameMs: 200,
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

      const vertEntry = getVerticalDim(dataset);
      if (vertEntry) {
        const [, vertDim] = vertEntry;
        const vertLabel = dataset.vertical_label ?? "depth";
        const vertValues = [...(vertDim.values ?? [])].sort((a, b) => a - b);
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
            layer.setDepth(ev.value);
            updateInfo();
          });

        dataFolderChildren.push(vertBinding);
      }

      if (dataset.type === "scalar") {
        const varKeys = Object.keys(dataset.variables);
        if (varKeys.length > 1) {
          const varOptions = varKeys.map(k => ({ text: k, value: k }));
          const varBinding = dataFolder
            .addBinding(PARAMS, "scalarVariable", { options: varOptions, label: "variable" })
            .on("change", (ev) => { layer.setScalarVariable(ev.value); updateInfo(); });
          dataFolderChildren.push(varBinding);
        }
      }
    }

    // ── switchDataset ──────────────────────────────────────────────

    const layerEventHandlers: { onLoaded?: (meta: FieldMeta) => void } = {};

    function switchDataset(dataset: CatalogDataset) {
      currentPlayer?.pause();
      if (map.getLayer("particles")) map.removeLayer("particles");

      currentDataset = dataset;

      const isScalar = dataset.type === "scalar";
      const varKeys = Object.keys(dataset.variables);
      const uVar = isScalar
        ? (dataset.defaults?.selectedVariable ?? varKeys[0] ?? "scalar")
        : (varKeys[0] ?? "uo");
      const vVar = isScalar ? undefined : (varKeys[1] ?? "vo");
      if (isScalar) PARAMS.scalarVariable = uVar;

      const timeDim = dataset.dimensions.time;
      const timeMin = timeDim.min ?? 0;
      const timeStep = timeDim.step ?? 21600000;
      const vertEntry = getVerticalDim(dataset);
      const vertValues = [...(vertEntry?.[1].values ?? [0])].sort(
        (a, b) => a - b,
      );

      const dsIdx = catalog.datasets.indexOf(dataset);
      if (pendingHashState && pendingHashState.d === dsIdx) {
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
        applyDefaults(dataset);
        PARAMS.timeIndex = 0;
        PARAMS.timeLabel = formatTime(timeMin);
        PARAMS.vertical = vertValues[0] ?? 0;
      }

      if (isScalar) currentRenderMode = "raster";

      layer = new ParticleLayer({
        id: "particles",
        source: dataset.zarr_url,
        variableU: uVar,
        variableV: vVar,
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
        scalarMode: isScalar,
        scalarUnit: isScalar ? (dataset.variables[uVar]?.units ?? "") : undefined,
      });

      if (layerEventHandlers.onLoaded) {
        layer.on("loaded", layerEventHandlers.onLoaded);
      }

      map.addLayer(layer);
      layer.setColorRamp(currentPaletteId);
      layer.setRenderMode(currentRenderMode);
      rebuildDataFolder(dataset);

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
      .on("change", (ev) => layer.setParticleDensity(ev.value));

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
        layer.setSpeedFactor([PARAMS.speedMin, PARAMS.speedMax]),
      );
    motionFolder
      .addBinding(PARAMS, "speedMax", {
        min: 0.01,
        max: 2,
        step: 0.01,
        label: "speed (global)",
      })
      .on("change", () =>
        layer.setSpeedFactor([PARAMS.speedMin, PARAMS.speedMax]),
      );
    motionFolder
      .addBinding(PARAMS, "dropRate", {
        min: 0,
        max: 0.1,
        step: 0.001,
        label: "drop rate",
      })
      .on("change", (ev) => layer.setDropRate(ev.value));
    motionFolder
      .addBinding(PARAMS, "dropRateBump", {
        min: 0,
        max: 0.1,
        step: 0.001,
        label: "drop bump",
      })
      .on("change", (ev) => layer.setDropRateBump(ev.value));

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
        layer.setFadeOpacity([PARAMS.fadeMin, PARAMS.fadeMax]),
      );
    trailFolder
      .addBinding(PARAMS, "fadeMax", {
        min: 0.9,
        max: 1,
        step: 0.0001,
        label: "fade (global)",
      })
      .on("change", () =>
        layer.setFadeOpacity([PARAMS.fadeMin, PARAMS.fadeMax]),
      );

    // ── Initial dataset (from hash or first) ───────────────────────

    const initialIdx = Math.min(
      Math.max(pendingHashState?.d ?? 0, 0),
      catalog.datasets.length - 1,
    );
    PARAMS.datasetIndex = initialIdx;
    switchDataset(catalog.datasets[initialIdx]);

    // ── Render Mode folder ────────────────────────────────────────

    const renderModeFolder = pane.addFolder({ title: "Render Mode" });
    const renderModes: RenderMode[] = ["raster", "particles", "raster+particles"];

    const renderModeBtnContainer = document.createElement("div");
    renderModeBtnContainer.className = "render-mode-btns";

    for (const mode of renderModes) {
      const btn = document.createElement("button");
      btn.textContent = mode;
      btn.className =
        "render-mode-btn" + (mode === currentRenderMode ? " active" : "");
      btn.addEventListener("click", () => {
        currentRenderMode = mode;
        layer.setRenderMode(mode);
        for (const entry of renderModeButtons) {
          entry.btn.classList.toggle("active", entry.mode === mode);
        }
      });
      renderModeButtons.push({ mode, btn });
      renderModeBtnContainer.appendChild(btn);
    }

    renderModeFolder.element.appendChild(renderModeBtnContainer);

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
      layer.setColorRamp(currentPaletteId);
      updateStandaloneLegendGradient();
    });

    paletteFolder.element.appendChild(paletteSelect);
    paletteSelectEl = paletteSelect;

    paletteFolder
      .addBinding(PARAMS, "opacity", { min: 0, max: 1, step: 0.01, label: "opacity" })
      .on("change", (ev) => layer.setOpacity(ev.value));
    paletteFolder
      .addBinding(PARAMS, "vibrance", { min: -1, max: 1, step: 0.01, label: "vibrance" })
      .on("change", (ev) => layer.setVibrance(ev.value));
    paletteFolder
      .addBinding(PARAMS, "logScale", { label: "log scale" })
      .on("change", (ev) => layer.setLogScale(ev.value));

    // ── Export folder ─────────────────────────────────────────────

    const exportFolder = pane.addFolder({ title: "Export", expanded: false });

    exportFolder.addButton({ title: "Copy settings" }).on("click", () => {
      const isScalarDs = currentDataset.type === "scalar";
      const lines = [
        `  - id: ${currentDataset.id}`,
        `    palette: ${currentPaletteId}`,
        `    renderMode: ${currentRenderMode}`,
      ];
      if (!isScalarDs) {
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

    exportFolder.addButton({ title: "Share view" }).on("click", () => {
      const ds = catalog.datasets[PARAMS.datasetIndex];
      const timeMs =
        (ds.dimensions.time.min ?? 0) +
        PARAMS.timeIndex * (ds.dimensions.time.step ?? 21600000);
      const state: HashState = {
        d: PARAMS.datasetIndex,
        t: timeMs,
        v: PARAMS.vertical,
        p: currentPaletteId,
        rm: currentRenderMode,
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
    layer.on("loaded", updateStandaloneLegendMeta);
    updateStandaloneLegendGradient();

  } catch (err) {
    console.error("Failed to initialize:", err);
  }
});
