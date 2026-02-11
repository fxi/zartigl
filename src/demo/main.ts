import maplibregl from "maplibre-gl";
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

function setStatus(msg: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

map.on("load", async () => {
  setStatus("Loading catalog...");

  try {
    const catalog = await loadCatalog();
    const dataset = catalog.datasets[0];
    if (!dataset) {
      setStatus("No datasets in catalog");
      return;
    }

    setStatus(`Loading ${dataset.label}...`);

    const layer = new ParticleLayer({
      id: "particles",
      source: dataset.zarr_url,
      variableU: "uo",
      variableV: "vo",
      time: 0,
      depth: 0,
      particleCount: 65536,
      speedFactor: 0.25,
      fadeOpacity: 0.996,
      dropRate: 0.003,
      dropRateBump: 0.01,
    });

    map.addLayer(layer);

    // ── Controls ─────────────────────────────────────────────────────

    const speedInput = document.getElementById("speed") as HTMLInputElement;
    const speedVal = document.getElementById("speed-val")!;
    speedInput.addEventListener("input", () => {
      const v = parseFloat(speedInput.value);
      speedVal.textContent = v.toFixed(2);
      layer.setSpeedFactor(v);
    });

    const fadeInput = document.getElementById("fade") as HTMLInputElement;
    const fadeVal = document.getElementById("fade-val")!;
    fadeInput.addEventListener("input", () => {
      const v = parseFloat(fadeInput.value);
      fadeVal.textContent = v.toFixed(3);
      layer.setFadeOpacity(v);
    });

    setStatus("");
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`);
    console.error(err);
  }
});
