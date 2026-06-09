import maplibregl from "maplibre-gl";
import { Zartigl } from "../lib";
import { catalog, formatVertical } from "../catalog";
import type { CatalogLayer } from "../catalog";

type Backend = "auto" | "zarr" | "wmts";

const map = new maplibregl.Map({
  container: "map",
  style: `https://api.maptiler.com/maps/satellite-v4/style.json?key=${import.meta.env.MAPTILER_TOKEN}`,
  center: [0, 20],
  zoom: 2,
  maxZoom: 8,
});

const layerSelect = document.querySelector<HTMLSelectElement>("#layer")!;
const backendSelect = document.querySelector<HTMLSelectElement>("#backend")!;
const visibilityBtn = document.querySelector<HTMLButtonElement>("#visibility")!;
const timeInput = document.querySelector<HTMLInputElement>("#time")!;
const depthSelect = document.querySelector<HTMLSelectElement>("#depth")!;
const mercatorBtn = document.querySelector<HTMLButtonElement>("#mercator")!;
const globeBtn = document.querySelector<HTMLButtonElement>("#globe")!;
const paletteSelect = document.querySelector<HTMLSelectElement>("#palette")!;
const logScaleBtn = document.querySelector<HTMLButtonElement>("#logscale")!;
const opacityInput = document.querySelector<HTMLInputElement>("#opacity")!;
const legendEl = document.querySelector<HTMLDivElement>("#legend")!;
const queryEl = document.querySelector<HTMLPreElement>("#query")!;

let z: Zartigl | null = null;
let currentLayer = catalog.layers[0];
let visible = true;
let requestedProjection: "mercator" | "globe" = "mercator";
let logScale = false;

function datetimeValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

function renderLayerOptions(): void {
  for (const layer of catalog.layers) {
    const option = document.createElement("option");
    option.value = layer.id;
    option.textContent = layer.label;
    layerSelect.appendChild(option);
  }
}

function renderPaletteOptions(): void {
  paletteSelect.replaceChildren();
  const palettes = z?.getPalettes() ?? [];
  for (const palette of palettes) {
    const option = document.createElement("option");
    option.value = palette.id;
    option.textContent = palette.label;
    paletteSelect.appendChild(option);
  }
}

function renderTimeControl(): void {
  if (!z) return;
  const time = z.getTimeMeta();
  const step = time.step ?? 3600000;
  timeInput.min = Number.isFinite(time.min) ? datetimeValue(time.min) : "";
  timeInput.max = Number.isFinite(time.max) ? datetimeValue(time.max) : "";
  timeInput.step = String(Math.max(60, Math.round(step / 1000)));
  timeInput.value = datetimeValue(time.current ?? time.max);
}

function renderDepthControl(): void {
  if (!z) return;
  const depth = z.getDepthMeta();
  depthSelect.replaceChildren();
  depthSelect.hidden = depth.values.length === 0;
  for (const value of depth.values) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = formatVertical(value, depth.label);
    depthSelect.appendChild(option);
  }
  depthSelect.value = String(depth.current ?? depth.values[0] ?? 0);
}

function renderLegend(): void {
  if (!z) return;
  const legend = z.getLegend();
  legendEl.replaceChildren();
  if (legend.type === "image") {
    const img = document.createElement("img");
    img.src = legend.url;
    legendEl.appendChild(img);
    return;
  }
  if (legend.type !== "gradient") return;
  const palettes = z.getPalettes();
  const palette = palettes.find((candidate) => candidate.id === legend.palette);
  const bar = document.createElement("div");
  bar.className = "legend-bar";
  bar.style.background = palette
    ? `linear-gradient(to right, ${palette.colors.join(", ")})`
    : "linear-gradient(to right, #3288bd, #fee08b, #d53e4f)";
  const meta = document.createElement("div");
  meta.className = "legend-meta";
  meta.textContent = [
    legend.min?.toFixed(2) ?? "",
    legend.unit ?? currentLayer.variables.units ?? "",
    legend.max?.toFixed(2) ?? "",
  ].join(" ");
  legendEl.append(bar, meta);
}

function setProjection(type: "mercator" | "globe"): void {
  requestedProjection = type;
  mercatorBtn.classList.toggle("active", type === "mercator");
  globeBtn.classList.toggle("active", type === "globe");
  if (map.isStyleLoaded()) {
    map.setProjection({ type });
  }
}

async function createController(layer: CatalogLayer = currentLayer): Promise<void> {
  z?.destroy();
  currentLayer = layer;
  z = new Zartigl({
    id: "minimal-zartigl",
    map,
    catalog,
    backend: backendSelect.value as Backend,
    visible,
  });
  await z.setLayer(layer.id);
  renderPaletteOptions();
  paletteSelect.value = typeof layer.defaults?.palette === "string" ? layer.defaults.palette : "rdylbu";
  logScale = layer.defaults?.raster?.logScale ?? false;
  logScaleBtn.classList.toggle("active", logScale);
  opacityInput.value = String(layer.defaults?.raster?.opacity ?? 1);
  renderTimeControl();
  renderDepthControl();
  renderLegend();
}

layerSelect.addEventListener("change", () => {
  const layer = catalog.layers.find((candidate) => candidate.id === layerSelect.value);
  if (layer) void createController(layer);
});

backendSelect.addEventListener("change", () => {
  void createController(currentLayer);
});

visibilityBtn.addEventListener("click", () => {
  visible = !visible;
  visibilityBtn.textContent = visible ? "hide" : "show";
  if (visible) z?.show();
  else z?.hide();
});

timeInput.addEventListener("change", () => {
  if (!timeInput.value) return;
  z?.setTime(new Date(timeInput.value));
  renderLegend();
});

depthSelect.addEventListener("change", () => {
  z?.setDepth(Number(depthSelect.value));
});

paletteSelect.addEventListener("change", () => {
  z?.updateSettings({ palette: paletteSelect.value });
  renderLegend();
});

logScaleBtn.addEventListener("click", () => {
  logScale = !logScale;
  logScaleBtn.classList.toggle("active", logScale);
  z?.updateSettings({ logScale });
  renderLegend();
});

opacityInput.addEventListener("input", () => {
  z?.updateSettings({ opacity: Number(opacityInput.value) });
});

mercatorBtn.addEventListener("click", () => setProjection("mercator"));
globeBtn.addEventListener("click", () => setProjection("globe"));

map.on("click", async (event) => {
  if (!z) return;
  queryEl.textContent = "loading";
  try {
    const result = await z.queryTimeSeries({
      longitude: event.lngLat.lng,
      latitude: event.lngLat.lat,
      maxPoints: 96,
    });
    queryEl.textContent = JSON.stringify(result, null, 2);
  } catch (err) {
    queryEl.textContent = err instanceof Error ? err.message : String(err);
  }
});

map.on("load", () => {
  map.setProjection({ type: requestedProjection });
});

renderLayerOptions();
setProjection("mercator");
queryEl.textContent = "";
void createController(currentLayer);
