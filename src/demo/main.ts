import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
import type { BindingApi, FolderApi } from "@tweakpane/core";
import { ParticleLayer, getPalettes } from "../lib/index.js";
import type { RenderMode } from "../lib/ParticleSimulation.js";
import type { FieldMeta } from "../lib/index.js";

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

interface CatalogDataset {
  id: string;
  product: string;
  label: string;
  zarr_url: string;
  variables: Record<string, { standard_name: string; units: string }>;
  dimensions: Record<string, CatalogDimension>;
  vertical_label?: string;
  default_speed_factor?: number;
}

interface Catalog {
  generated: string;
  datasets: CatalogDataset[];
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

    const PARAMS = {
      datasetIndex: 0,
      timeIndex: 0,
      timeLabel: "",
      vertical: 0,
      particleDensity: 0.05,
      // Speed factor — [min=local, max=global]
      speedMin: 0.07,
      speedMax: 0.27,
      // Fade opacity — [min=local, max=global]
      fadeMin: 0.9,
      fadeMax: 0.9315,
      dropRate: 0.003,
      dropRateBump: 0.01,
      opacity: 1.0,
      logScale: false,
      vibrance: 0.0,
    };

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
      // Dispose previous children
      for (const c of dataFolderChildren) c.dispose();
      dataFolderChildren = [];

      const timeDim = dataset.dimensions.time;
      const timeMin = timeDim.min ?? 0;
      const timeStep = timeDim.step ?? 21600000;
      const timeSize = timeDim.size ?? 1;

      const timeSlider = dataFolder
        .addBinding(PARAMS, "timeIndex", {
          min: 0,
          max: timeSize - 1,
          step: 1,
          label: "time",
        })
        .on("change", (ev) => {
          const ms = timeMin + ev.value * timeStep;
          PARAMS.timeLabel = formatTime(ms);
          timeLabelBinding.refresh();
          layer.setTime(ms);
          updateInfo();
        });

      const timeLabelBinding = dataFolder.addBinding(PARAMS, "timeLabel", {
        readonly: true,
        label: "",
      }) as BindingApi;

      dataFolderChildren.push(timeSlider, timeLabelBinding);

      // Vertical selector — only if dataset has a z-axis dimension
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
    }

    // ── switchDataset ──────────────────────────────────────────────

    // Holder so switchDataset can attach event listeners defined later.
    const layerEventHandlers: {
      onLoaded?: (meta: FieldMeta) => void;
    } = {};

    function switchDataset(dataset: CatalogDataset) {
      if (map.getLayer("particles")) map.removeLayer("particles");

      currentDataset = dataset;

      const varKeys = Object.keys(dataset.variables);
      const uVar = varKeys[0] ?? "uo";
      const vVar = varKeys[1] ?? "vo";

      const timeDim = dataset.dimensions.time;
      const timeMin = timeDim.min ?? 0;
      const vertEntry = getVerticalDim(dataset);
      const vertValues = [...(vertEntry?.[1].values ?? [0])].sort(
        (a, b) => a - b,
      );

      PARAMS.timeIndex = 0;
      PARAMS.timeLabel = formatTime(timeMin);
      PARAMS.vertical = vertValues[0] ?? 0;

      layer = new ParticleLayer({
        id: "particles",
        source: dataset.zarr_url,
        variableU: uVar,
        variableV: vVar,
        time: timeMin,
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

      // Attach event listeners defined later in this closure
      if (layerEventHandlers.onLoaded) {
        layer.on('loaded', layerEventHandlers.onLoaded);
      }

      map.addLayer(layer);
      layer.setColorRamp(currentPaletteId);

      rebuildDataFolder(dataset);
      updateInfo();
    }

    // Initialize with first dataset
    switchDataset(catalog.datasets[0]);

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
      .on("change", () => layer.setSpeedFactor([PARAMS.speedMin, PARAMS.speedMax]));
    motionFolder
      .addBinding(PARAMS, "speedMax", {
        min: 0.01,
        max: 2,
        step: 0.01,
        label: "speed (global)",
      })
      .on("change", () => layer.setSpeedFactor([PARAMS.speedMin, PARAMS.speedMax]));
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
      .on("change", () => layer.setFadeOpacity([PARAMS.fadeMin, PARAMS.fadeMax]));
    trailFolder
      .addBinding(PARAMS, "fadeMax", {
        min: 0.9,
        max: 1,
        step: 0.0001,
        label: "fade (global)",
      })
      .on("change", () => layer.setFadeOpacity([PARAMS.fadeMin, PARAMS.fadeMax]));

    // ── Render Mode folder ────────────────────────────────────────

    let currentRenderMode: RenderMode = 'raster+particles';

    const renderModeFolder = pane.addFolder({ title: "Render Mode" });
    const renderModes: RenderMode[] = ['raster', 'particles', 'raster+particles'];
    const renderModeButtons: { mode: RenderMode; btn: HTMLButtonElement }[] = [];

    const renderModeBtnContainer = document.createElement("div");
    renderModeBtnContainer.className = "render-mode-btns";

    for (const mode of renderModes) {
      const btn = document.createElement("button");
      btn.textContent = mode;
      btn.className = "render-mode-btn" + (mode === currentRenderMode ? " active" : "");
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

    const palettes = getPalettes();
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

    paletteFolder
      .addBinding(PARAMS, "opacity", { min: 0, max: 1, step: 0.01, label: "opacity" })
      .on("change", (ev) => layer.setOpacity(ev.value));
    paletteFolder
      .addBinding(PARAMS, "vibrance", { min: -1, max: 1, step: 0.01, label: "vibrance" })
      .on("change", (ev) => layer.setVibrance(ev.value));
    paletteFolder
      .addBinding(PARAMS, "logScale", { label: "log scale" })
      .on("change", (ev) => layer.setLogScale(ev.value));

    // ── Standalone legend (bottom-center DOM element) ─────────────

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

    // Register handler so switchDataset (defined earlier) attaches it on each new layer.
    layerEventHandlers.onLoaded = updateStandaloneLegendMeta;
    // Also attach to the already-created first layer (switchDataset was called above).
    layer.on('loaded', updateStandaloneLegendMeta);

    updateStandaloneLegendGradient();

  } catch (err) {
    console.error("Failed to initialize:", err);
  }
});
