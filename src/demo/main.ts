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
}

interface CatalogView {
  id: string;
  label: string;
  description?: string;
  category?: string;
  type: "vector" | "scalar";
  source_dataset: string;
  zarr_url_geo: string;
  zarr_url_time?: string;
  variable?: string;
  variable_u?: string;
  variable_v?: string;
  variable_meta?: { standard_name: string; units: string };
  dimensions: Record<string, CatalogDimension>;
  vertical_label?: string;
  defaults?: LayerDefaults;
}

interface Catalog {
  generated: string;
  views: CatalogView[];
}

// ── Hash state ───────────────────────────────────────────────────────

interface HashState {
  d: number;    // view index
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
  view: CatalogView,
): [string, CatalogDimension] | undefined {
  return Object.entries(view.dimensions).find(([, d]) => d.axis === "z");
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
  style: `https://api.maptiler.com/maps/satellite-v4/style.json?key=${import.meta.env.MAPTILER_TOKEN}`,
  center: [0, 20],
  zoom: 2,
  maxZoom: 8,
});
window.map = map;

// ── Init ─────────────────────────────────────────────────────────────

map.on("load", async () => {
  try {
    const catalog = await loadCatalog();
    if (!catalog.views.length) {
      console.error("No views in catalog");
      return;
    }

    // ── Shared mutable state ───────────────────────────────────────

    let layer: ParticleLayer = null!;
    let currentView: CatalogView;
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

    // Pending hash state — consumed on first matching switchView call
    let pendingHashState = loadHashState();

    // DOM element refs — assigned when UI is built, used by refreshUI()
    let paletteSelectEl: HTMLSelectElement | null = null;
    let viewSelectEl: HTMLSelectElement | null = null;
    let renderModeButtons: { mode: RenderMode; btn: HTMLButtonElement }[] = [];
    let projectionButtons: { proj: string; btn: HTMLButtonElement }[] = [];
    let currentProjection: "mercator" | "globe" = "mercator";

    const PARAMS = {
      viewIndex: 0,
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

    function applyDefaults(view: CatalogView) {
      const d = view.defaults ?? {};
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
      if (viewSelectEl) viewSelectEl.value = String(PARAMS.viewIndex);
      const isScalar = currentView?.type === "scalar";
      for (const { mode, btn } of renderModeButtons) {
        btn.classList.toggle("active", mode === currentRenderMode);
        btn.disabled = isScalar && mode !== "raster";
      }
      for (const { proj, btn } of projectionButtons) {
        btn.classList.toggle("active", proj === currentProjection);
      }
      pane.refresh();
      updateStandaloneLegendGradient();
    }

    // ── View meta element (assigned when View folder is built) ─────

    let viewMetaEl: HTMLDivElement = null!;

    function updateInfo() {
      if (!viewMetaEl) return;
      const v = currentView;
      const meta = v.variable_meta;
      const metaStr = meta
        ? `${meta.standard_name.replace(/_/g, " ")} — ${meta.units}`
        : "";
      viewMetaEl.textContent = [v.description, metaStr].filter(Boolean).join("\n");
    }

    // ── Tweakpane ─────────────────────────────────────────────────

    const pane = new Pane({ title: "zartigl", expanded: false });

    // View selector — grouped by category using optgroup
    if (catalog.views.length > 1) {
      const viewFolder = pane.addFolder({ title: "View" }) as FolderApi;

      const viewSelect = document.createElement("select");
      viewSelect.className = "view-select";

      // Collect categories in order of first appearance
      const seen = new Set<string>();
      const cats: string[] = [];
      for (const v of catalog.views) {
        const cat = v.category ?? "Other";
        if (!seen.has(cat)) { seen.add(cat); cats.push(cat); }
      }

      if (cats.length > 1) {
        for (const cat of cats) {
          const grp = document.createElement("optgroup");
          grp.label = cat;
          catalog.views.forEach((v, i) => {
            if ((v.category ?? "Other") !== cat) return;
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = v.label;
            grp.appendChild(opt);
          });
          viewSelect.appendChild(grp);
        }
      } else {
        catalog.views.forEach((v, i) => {
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = v.label;
          viewSelect.appendChild(opt);
        });
      }

      viewSelect.value = String(PARAMS.viewIndex);
      viewSelect.addEventListener("change", () => {
        PARAMS.viewIndex = Number(viewSelect.value);
        switchView(catalog.views[PARAMS.viewIndex]);
      });

      viewFolder.element.appendChild(viewSelect);
      viewSelectEl = viewSelect;

      const viewMetaDiv = document.createElement("div");
      viewMetaDiv.className = "view-meta";
      viewFolder.element.appendChild(viewMetaDiv);
      viewMetaEl = viewMetaDiv;
    }

    // ── Data folder (rebuilt on view switch) ────────────────────────

    const dataFolder = pane.addFolder({ title: "Data" }) as FolderApi;

    function rebuildDataFolder(view: CatalogView) {
      for (const c of dataFolderChildren) c.dispose();
      dataFolderChildren = [];

      const timeDim = view.dimensions.time;
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

      {
        const playerContainer = document.createElement("div");
        playerContainer.className = "player-btns";
        const btn = document.createElement("button");
        btn.className = "player-btn";
        btn.textContent = "▶ play";
        playBtn = btn;

        // Scalar datasets animate at 5 fps for smooth transitions.
        // Vector datasets update the velocity field at 0.5 fps so the particle
        // animation continues uninterrupted between time steps.
        const isVector = view.type === "vector";
        const frameMs = isVector ? 2000 : 200;
        // Vector has 2× the data per frame (U+V); buffer less to avoid heavy prefetch.
        const bufferAhead = isVector ? 2 : 10;

        const player = new TimelinePlayer(layer, PARAMS.timeIndex, {
          timeMin, timeStep, timeSize,
          bufferAhead,
          frameMs,
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

      const vertEntry = getVerticalDim(view);
      if (vertEntry) {
        const [, vertDim] = vertEntry;
        const vertLabel = view.vertical_label ?? "depth";
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
    }

    // ── switchView ────────────────────────────────────────────────

    const layerEventHandlers: { onLoaded?: (meta: FieldMeta) => void } = {};

    function switchView(view: CatalogView) {
      currentPlayer?.pause();
      if (map.getLayer("particles")) map.removeLayer("particles");

      currentView = view;

      const isScalar = view.type === "scalar";
      const uVar = isScalar ? (view.variable ?? "scalar") : (view.variable_u ?? "uo");
      const vVar = isScalar ? undefined : view.variable_v;

      const timeDim = view.dimensions.time;
      const timeMin = timeDim.min ?? 0;
      const timeStep = timeDim.step ?? 21600000;
      const vertEntry = getVerticalDim(view);
      const vertValues = [...(vertEntry?.[1].values ?? [0])].sort(
        (a, b) => a - b,
      );

      const viewIdx = catalog.views.indexOf(view);
      if (pendingHashState && pendingHashState.d === viewIdx) {
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
        applyDefaults(view);
        PARAMS.timeIndex = (timeDim.size ?? 1) - 1;
        PARAMS.timeLabel = formatTime(timeMin + PARAMS.timeIndex * timeStep);
        PARAMS.vertical = vertValues[0] ?? 0;
      }

      if (isScalar) currentRenderMode = "raster";

      layer = new ParticleLayer({
        id: "particles",
        source: view.zarr_url_geo,
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
        scalarUnit: isScalar ? (view.variable_meta?.units ?? "") : undefined,
      });

      if (layerEventHandlers.onLoaded) {
        layer.on("loaded", layerEventHandlers.onLoaded);
      }

      map.addLayer(layer);
      layer.setColorRamp(currentPaletteId);
      layer.setRenderMode(currentRenderMode);
      rebuildDataFolder(view);

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

    // ── Initial view (from hash or first) ─────────────────────────

    const initialIdx = Math.min(
      Math.max(pendingHashState?.d ?? 0, 0),
      catalog.views.length - 1,
    );
    PARAMS.viewIndex = initialIdx;
    switchView(catalog.views[initialIdx]);

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

    renderModeFolder.element.appendChild(projBtnContainer);

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
    paletteFolder.element.appendChild(legendContainer);
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
      const isScalarV = currentView.type === "scalar";
      const lines = [
        `  - id: ${currentView.id}`,
        `    palette: ${currentPaletteId}`,
        `    renderMode: ${currentRenderMode}`,
      ];
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

    exportFolder.addButton({ title: "Share view" }).on("click", () => {
      const v = catalog.views[PARAMS.viewIndex];
      const timeMs =
        (v.dimensions.time.min ?? 0) +
        PARAMS.timeIndex * (v.dimensions.time.step ?? 21600000);
      const state: HashState = {
        d: PARAMS.viewIndex,
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
