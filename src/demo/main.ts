import maplibregl from "maplibre-gl";
import { Pane } from "tweakpane";
import { ParticleLayer } from "../lib/index.js";

// ── Catalog ──────────────────────────────────────────────────────────

interface CatalogDataset {
  id: string;
  label: string;
  zarr_url: string;
  variables: Record<string, { standard_name: string; units: string }>;
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

    const PARAMS = {
      particleCount: 65536,
      speedFactor: 0.25,
      fadeOpacity: 0.996,
      dropRate: 0.003,
      dropRateBump: 0.01,
      pointSize: 1.0,
      colorLow: "#3288bd",
      colorMid: "#fdae61",
      colorHigh: "#d53e4f",
    };

    const layer = new ParticleLayer({
      id: "particles",
      source: dataset.zarr_url,
      variableU: "uo",
      variableV: "vo",
      time: 0,
      depth: 0,
      particleCount: PARAMS.particleCount,
      speedFactor: PARAMS.speedFactor,
      fadeOpacity: PARAMS.fadeOpacity,
      dropRate: PARAMS.dropRate,
      dropRateBump: PARAMS.dropRateBump,
      pointSize: PARAMS.pointSize,
    });

    map.addLayer(layer);

    // ── Tweakpane ───────────────────────────────────────────────────

    const pane = new Pane({ title: "zartigl" });

    // Particles folder
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

    // Motion folder
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

    // Trail folder
    const trailFolder = pane.addFolder({ title: "Trail" });
    trailFolder
      .addBinding(PARAMS, "fadeOpacity", {
        min: 0.9,
        max: 0.999,
        step: 0.001,
        label: "fade",
      })
      .on("change", (ev) => layer.setFadeOpacity(ev.value));

    // Colors folder
    const colorsFolder = pane.addFolder({ title: "Colors" });

    function updateColorRamp() {
      layer.setColorRamp({
        0.0: PARAMS.colorLow,
        0.5: PARAMS.colorMid,
        1.0: PARAMS.colorHigh,
      });
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
  } catch (err) {
    console.error("Failed to initialize:", err);
  }
});
