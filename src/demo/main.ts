import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
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

function formatDepth(v: number): string {
  if (v < 10) return `${v.toFixed(2)} m`;
  if (v < 100) return `${v.toFixed(1)} m`;
  return `${Math.round(v)} m`;
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
    const dataset = catalog.datasets[0];
    if (!dataset) {
      console.error("No datasets in catalog");
      return;
    }

    // ── Dimension metadata from catalog ───────────────────────────

    const timeDim = dataset.dimensions.time;
    const depthDim = dataset.dimensions.depth;
    const depthValues = [...(depthDim.values ?? [])].sort((a, b) => a - b);

    const timeMin = timeDim.min ?? 0;
    const timeStep = timeDim.step ?? 21600000;
    const timeSize = timeDim.size ?? 1;

    const initialTimeMs = timeMin;
    const initialDepth = depthValues[0] ?? 0;

    // ── Params ────────────────────────────────────────────────────

    const PARAMS = {
      timeIndex: 0,
      timeLabel: formatTime(initialTimeMs),
      depth: initialDepth,
      particleCount: 262144,
      speedFactor: 2,
      fadeOpacity: 0.99991,
      dropRate: 0.003,
      dropRateBump: 0.01,
      pointSize: 1.0,
      colorLow: "#3288bd",
      colorMid: "#fdae61",
      colorHigh: "#d53e4f",
    };

    // ── Layer ─────────────────────────────────────────────────────

    const layer = new ParticleLayer({
      id: "particles",
      source: dataset.zarr_url,
      variableU: "uo",
      variableV: "vo",
      time: initialTimeMs,
      depth: initialDepth,
      particleCount: PARAMS.particleCount,
      speedFactor: PARAMS.speedFactor,
      fadeOpacity: PARAMS.fadeOpacity,
      dropRate: PARAMS.dropRate,
      dropRateBump: PARAMS.dropRateBump,
      pointSize: PARAMS.pointSize,
    });

    map.addLayer(layer);

    // ── Info panel (bottom-left) ──────────────────────────────────

    const infoEl = document.getElementById("info")!;

    function updateInfo() {
      const vars = Object.entries(dataset.variables)
        .map(([k, v]) => `${k} (${v.standard_name.replace(/_/g, " ")})`)
        .join(" + ");
      const units = Object.values(dataset.variables)[0]?.units ?? "";
      infoEl.textContent =
        `${dataset.product}\n` +
        `${dataset.label}\n` +
        `${vars} — ${units}\n` +
        `Time: ${PARAMS.timeLabel}  Depth: ${formatDepth(PARAMS.depth)}`;
    }

    updateInfo();

    // ── Tweakpane ─────────────────────────────────────────────────

    const pane = new Pane({ title: "zartigl" });

    // ── Data folder ───────────────────────────────────────────────

    const dataFolder = pane.addFolder({ title: "Data" });

    dataFolder
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
    });

    const depthOptions = depthValues.map((v) => ({
      text: formatDepth(v),
      value: v,
    }));

    dataFolder
      .addBinding(PARAMS, "depth", {
        options: depthOptions,
        label: "depth",
      })
      .on("change", (ev) => {
        layer.setDepth(ev.value);
        updateInfo();
      });

    // ── Particles folder ──────────────────────────────────────────

    const particlesFolder = pane.addFolder({ title: "Particles" });
    particlesFolder
      .addBinding(PARAMS, "particleCount", {
        min: 1024,
        max: 262144,
        step: 1024,
        label: "count",
      })
      .on("change", (ev) => layer.setParticleCount(ev.value));
    particlesFolder
      .addBinding(PARAMS, "pointSize", {
        min: 0.5,
        max: 5,
        step: 0.5,
        label: "size",
      })
      .on("change", (ev) => layer.setPointSize(ev.value));

    // ── Motion folder ─────────────────────────────────────────────

    const motionFolder = pane.addFolder({ title: "Motion" });
    motionFolder
      .addBinding(PARAMS, "speedFactor", {
        min: 0.01,
        max: 2,
        step: 0.01,
        label: "speed",
      })
      .on("change", (ev) => layer.setSpeedFactor(ev.value));
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
      .addBinding(PARAMS, "fadeOpacity", {
        min: 0.9,
        max: 1,
        step: 0.0001,
        label: "fade",
      })
      .on("change", (ev) => layer.setFadeOpacity(ev.value));

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
