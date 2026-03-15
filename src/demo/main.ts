import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
import type { BindingApi, FolderApi } from "@tweakpane/core";
import { ParticleLayer } from "../lib/index.js";

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

    let layer: ParticleLayer;
    let currentDataset: CatalogDataset;
    let dataFolderChildren: { dispose(): void }[] = [];

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
      colorLow: "#3288bd",
      colorMid: "#fdae61",
      colorHigh: "#d53e4f",
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
      });
      map.addLayer(layer);

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

    // ── Colors folder ─────────────────────────────────────────────

    const colorsFolder = pane.addFolder({ title: "Colors" });

    function updateColorRamp() {
      layer.setColorRamp({
        0.0: PARAMS.colorLow,
        0.5: PARAMS.colorMid,
        1.0: PARAMS.colorHigh,
      });
      drawLegend();
    }

    colorsFolder
      .addBinding(PARAMS, "colorLow", { label: "slow" })
      .on("change", updateColorRamp);
    colorsFolder
      .addBinding(PARAMS, "colorMid", { label: "mid" })
      .on("change", updateColorRamp);
    colorsFolder
      .addBinding(PARAMS, "colorHigh", { label: "fast" })
      .on("change", updateColorRamp);

    // ── Legend (below pane) ───────────────────────────────────────

    const legendDiv = document.createElement("div");
    legendDiv.id = "legend";

    const legendCanvas = document.createElement("canvas");
    legendCanvas.width = 200;
    legendCanvas.height = 10;

    const legendLabels = document.createElement("div");
    legendLabels.className = "legend-labels";
    legendLabels.innerHTML = "<span>slow</span><span>fast</span>";

    legendDiv.appendChild(legendCanvas);
    legendDiv.appendChild(legendLabels);
    pane.element.appendChild(legendDiv);

    function drawLegend() {
      const ctx = legendCanvas.getContext("2d")!;
      const grad = ctx.createLinearGradient(0, 0, legendCanvas.width, 0);
      grad.addColorStop(0, PARAMS.colorLow);
      grad.addColorStop(0.5, PARAMS.colorMid);
      grad.addColorStop(1, PARAMS.colorHigh);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, legendCanvas.width, legendCanvas.height);
    }

    drawLegend();
  } catch (err) {
    console.error("Failed to initialize:", err);
  }
});
