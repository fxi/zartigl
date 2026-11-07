/**
 * Pacific Thermocline Data-Cube: monthly GODAS potential temperature of the
 * equatorial Pacific (120° E–80° W, 14.5° S–15° N, 0–300 m) since 1980, read
 * in five-year blocks from the point-series Zarr store of the catalog entry.
 */

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./style.css";

import { requireCatalogEntry, resolveLocalizedText } from "../catalog";
import { ZarrSource } from "../lib/ZarrSource";
import { cacheChunkStore } from "../lib/chunkStore";
import {
  BlockCache,
  POTTMP,
  POTTMP_ANOM,
  loadBlock,
  monthVolume,
  type CubeVariable,
  type Volume,
} from "./data/blocks";
import { NINO34, createBox, latLabel, lonLabel } from "./data/box";
import { depthWeights } from "./data/depth";
import {
  anomaly,
  climatology,
  episodes,
  ninoSeries,
  runningMean,
} from "./data/nino";
import {
  PRESETS,
  blendViews,
  frame,
  unproject,
  type Preset,
  type View,
} from "./gl/camera";
import { CubeRenderer, LineBatch, type Show } from "./gl/renderer";
import {
  BOTTOM,
  LAT_STRETCH,
  STEPS,
  createSpace,
  fromWorld,
  toWorld,
} from "./gl/space";
import { rampBytes, rampColor, type PaletteName } from "./palettes";
import { coastlines } from "./ui/coast";
import { Labels } from "./ui/labels";
import { SlicePanel, type Cursor, type SliceKind } from "./ui/slice2d";
import { DataManager, type DataBlock } from "./ui/data-manager";
import { Timeline, type BlockStatus } from "./ui/timeline";

const ENTRY_ID = "1a088ef7-b187-4234-b651-1643978aa3b5";
/** The anomaly entry, for its title: both entries read the same store (v2). */
const ANOMALY_ENTRY_ID = "638a12a1-a953-48ac-b435-076496cf579a";
const DOMAIN: [number, number] = [10, 30];
/** The anomaly entry's catalog color domain. */
const ANOMALY_DOMAIN: [number, number] = [-5, 5];
type Mode = "absolute" | "anomaly";
const ISO = 20;
const MOBILE = 760;
const PRESET_NAMES: Record<Preset, string> = {
  iso: "3D ISO",
  top: "3D TOP",
  front: "3D FRONT",
  side: "3D SIDE",
  cavalier: "3D CAVALIER",
};

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function monthText(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function facts(target: HTMLElement, rows: Array<[string, string]>): void {
  target.replaceChildren(
    ...rows.flatMap(([term, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

const ICONS: Record<string, string> = {
  first: '<path d="M5 4v12M16 4 8 10l8 6z"/>',
  back: '<path d="M10 4 3 10l7 6zM18 4l-7 6 7 6z"/>',
  play: '<path d="M6 4l11 6-11 6z"/>',
  pause: '<path d="M6 4h3v12H6zM12 4h3v12h-3z"/>',
  forward: '<path d="M2 4l7 6-7 6zM10 4l7 6-7 6z"/>',
  last: '<path d="M15 4v12M4 4l8 6-8 6z"/>',
};

function icon(button: HTMLElement, name: string): void {
  button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>`;
}

async function main(): Promise<void> {
  const entry = requireCatalogEntry(ENTRY_ID);
  const anomalyEntry = requireCatalogEntry(ANOMALY_ENTRY_ID);
  // One store holds pottmp and pottmp_anom on the same time axis.
  const zarr = entry.sources.find((source) => source.type === "zarr");
  const url =
    zarr && "endpoints" in zarr ? zarr.endpoints.pointSeries : undefined;
  if (!url) {
    throw new Error("The GODAS entry has no point-series store");
  }

  const loading = $("loading");
  const status = (text: string | null) => {
    loading.hidden = !text;
    loading.textContent = text ?? "";
  };
  status("READING METADATA…");

  // Chunks persist across sessions: the stores only append months (see lib/chunkStore.ts).
  const chunkStore = cacheChunkStore();
  const source = new ZarrSource(url, 8, { chunkStore });
  await source.init();
  const coords = source.getCoords();
  const times = source.getTimeDimension().values;
  const chunk = source.getChunkShape(POTTMP.name);
  const [timeChunk, , tileLat, tileLon] = chunk;
  const tile = { latitude: tileLat, longitude: tileLon };
  const box = createBox(
    {
      longitude: coords.longitude,
      latitude: coords.latitude,
      depth: coords.vertical,
    },
    tile,
  );
  const space = createSpace(box);
  const weights = depthWeights(box.depth, STEPS, BOTTOM);
  const lastMonth = times.length - 1;
  const range = `${monthText(times[0])} – ${monthText(times[lastMonth])}`;
  const allDepths = Array.from(coords.vertical);

  /** The facts that name the shown variable. */
  const describe = (anomalyMode: boolean) => {
    const variable = anomalyMode
      ? "pottmp_anom (°C, base 1991–2020)"
      : "pottmp (°C)";
    $("entry-title").textContent = resolveLocalizedText(
      (anomalyMode ? anomalyEntry : entry).title,
      "en",
    );
    $("entry-subtitle").textContent = anomalyMode
      ? "Monthly departure of sea water potential temperature from 1991–2020"
      : "Monthly mean sea water potential temperature";
    facts($("dataset"), [
      ["Dataset", "pottmp (monthly means, bias-corrected)"],
      [
        "Period",
        `${range} · ${allDepths.length} levels · ${allDepths[0]} m to ${allDepths[allDepths.length - 1]} m`,
      ],
      ["Grid", "1° × 1/3° · 74.5° S – 64.5° N"],
      [
        "Kind",
        `scalar · variable: ${anomalyMode ? POTTMP_ANOM.name : POTTMP.name}`,
      ],
      ["id", anomalyMode ? ANOMALY_ENTRY_ID : ENTRY_ID],
    ]);
    $("bar-facts").textContent =
      `VAR: ${variable} | REGION: ${lonLabel(space.west)}–${lonLabel(space.east)}, ${latLabel(-14.5, 1)}–${latLabel(15)} | ROI: NIÑO 3.4 | DEPTH: 0–${BOTTOM} m | TIME: ${range} (MONTHLY)`;
  };
  /** Facts of the data cube, at the head of the DATA panel. */
  const cubeFacts = (anomalyMode: boolean): Array<[string, string]> => [
    [
      "VARIABLE",
      anomalyMode ? "pottmp + pottmp_anom (base 1991–2020)" : "pottmp (°C)",
    ],
    ["GRID", "1° × 1/3° · equatorial Pacific"],
    [
      "LEVELS",
      `${box.depth.length} of ${allDepths.length} (${box.depth[0]}–${box.depth[box.depth.length - 1]} m)`,
    ],
    ["TIME", range],
    [
      "BLOCKS",
      `${timeChunk} months · ${box.tiles.length * box.depth.length} chunks per variable`,
    ],
    ["STORE", url.replace(/^https?:\/\//, "")],
  ];
  describe(false);
  $("time-range").textContent = `(${range})`;
  $("scale").textContent =
    `lat ×${LAT_STRETCH} · depth ×${space.exaggeration.toLocaleString("en")} · ${box.depth.length} levels to ${box.depth[box.depth.length - 1]} m`;

  // Renderer and labels.
  const canvas = $<HTMLCanvasElement>("cube");
  let renderer: CubeRenderer;
  try {
    renderer = new CubeRenderer(canvas, space.half);
  } catch {
    status("THIS VIEW NEEDS WEBGL2.");
    return;
  }
  const stage = $("stage");
  const labels = new Labels(space);
  stage.append(labels.element);
  const coast = coastlines(space);
  {
    const batch = new LineBatch();
    for (const line of coast) {
      batch.polyline(line.map(([lon, lat]) => toWorld(space, lon, lat, 0)));
    }
    renderer.setLines("coast", batch);
    // The Niño 3.4 box over the upper 300 m.
    const min = toWorld(space, NINO34.west, NINO34.south, BOTTOM);
    const max = toWorld(space, NINO34.east, NINO34.north, 0);
    renderer.setLines("roi", new LineBatch().box(min, max));
    renderer.setLines("ticks", labels.ticks());
  }

  // State.
  let palette: PaletteName = "turbo";
  /** Absolute temperature, or its departure from 1991–2020 (balance palette, fixed). */
  let mode: Mode = "absolute";
  const anomalyMode = () => mode === "anomaly";
  const domain = () => (anomalyMode() ? ANOMALY_DOMAIN : DOMAIN);
  let ramp = rampBytes(palette);
  renderer.setPalette(ramp);
  const show: Show = {
    slices: true,
    iso: true,
    roi: true,
    coast: true,
    contours: true,
  };
  const cursor: Cursor = { lon: 220, lat: 0, depth: 100 };
  let view: View = { ...PRESETS.iso };
  let transition: { from: View; to: View; start: number } | null = null;
  let month = lastMonth;
  let shown = -1;
  let current: Volume | null = null;
  let nextMonth = -1;
  let playing = false;
  /** The view preset in use, null once the view was turned by hand. */
  let preset: Preset | null = "iso";
  /** `#…&capture`: video capture drives the months and their blend (see cubeCapture below). */
  const capture = /[#&]capture\b/.test(location.hash);
  let captureMix: number | null = null;
  let speed = 4;
  let dirty = true;
  const requestDraw = () => (dirty = true);

  // Data: one cache per variable; the anomaly is only read in anomaly mode.
  /** Re-reads what is on disk shortly after blocks were read (see the DATA panel). */
  let refreshTimer = 0;
  const refreshDisk = () => {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void manager.refresh(), 400);
  };
  const blockCache = (variable: CubeVariable, label: string) => {
    const cache: BlockCache = new BlockCache(
      (index) =>
        loadBlock(
          source,
          variable,
          box,
          index,
          timeChunk,
          times.length,
          tile,
          (progress) => {
            if (Math.floor(month / timeChunk) === index && !cache.has(index)) {
              const first = monthText(times[index * timeChunk]).slice(0, 4);
              const last = monthText(
                times[Math.min(lastMonth, (index + 1) * timeChunk - 1)],
              ).slice(0, 4);
              status(
                `LOADING ${label}${first}–${last} · ${progress.done}/${progress.total} CHUNKS`,
              );
            }
            updateBlocks();
          },
        ).then((block) => {
          refreshDisk();
          return block;
        }),
      3,
    );
    return cache;
  };
  const temperatures = blockCache(POTTMP, "");
  const departures = blockCache(POTTMP_ANOM, "ANOMALY ");
  /** The caches the current mode needs, read together. */
  const caches = () =>
    anomalyMode() ? [temperatures, departures] : [temperatures];
  const cache = {
    has: (b: number) => caches().every((c) => c.has(b)),
    loading: (b: number) => caches().some((c) => c.loading(b)),
    get: (b: number) => Promise.all(caches().map((c) => c.get(b))),
  };
  const blockOf = (m: number) => Math.floor(m / timeChunk);
  const volumeOf = (m: number): Volume | null => {
    const block = temperatures.peek(blockOf(m));
    const anomaly = anomalyMode() ? departures.peek(blockOf(m)) : undefined;
    if (!block || (anomalyMode() && !anomaly)) {
      return null;
    }
    return monthVolume(
      block,
      box,
      m - block.start,
      STEPS,
      BOTTOM,
      weights,
      anomaly,
    );
  };

  // Slice panels.
  const panels = new Map<SliceKind, SlicePanel>();
  for (const section of document.querySelectorAll<HTMLElement>(".slice")) {
    const kind = section.dataset.slice as SliceKind;
    const readout = section.querySelector<HTMLElement>(".slice-title")!;
    const panel = new SlicePanel(kind, space, coast, readout, (change) =>
      setCursor(change),
    );
    section.append(panel.canvas);
    panels.set(kind, panel);
  }
  const drawPanels = () => {
    for (const panel of panels.values()) {
      panel.update(
        current,
        { ...cursor },
        {
          ramp,
          domain: domain(),
          anomaly: anomalyMode(),
          contours: show.contours,
          roi: show.roi,
          coast: show.coast,
        },
      );
    }
  };

  // Timeline.
  status("READING NIÑO 3.4…");
  const series = await ninoSeries(
    source,
    coords,
    times.length,
    timeChunk,
    tile,
  );
  const index = runningMean(anomaly(series, times, climatology(series, times)));
  const timeline = new Timeline(
    Array.from(times),
    index,
    episodes(index),
    timeChunk,
    (m) => setMonth(m),
  );
  $("timeline").append(timeline.canvas);
  const blockCount = Math.ceil(times.length / timeChunk);
  /** Blocks of the current mode complete on disk, as last read by the DATA panel. */
  let onDisk = new Set<number>();
  const updateBlocks = () => {
    const states: BlockStatus[] = Array.from({ length: blockCount }, (_, b) =>
      cache.has(b)
        ? "loaded"
        : cache.loading(b)
          ? "loading"
          : onDisk.has(b)
            ? "cached"
            : "missing",
    );
    timeline.setStatus(states);
  };

  // DATA panel: the chunks of each block, on disk or to download.
  const blockLabel = (b: number) => {
    const first = monthText(times[b * timeChunk]).slice(0, 4);
    const last = monthText(
      times[Math.min(lastMonth, (b + 1) * timeChunk - 1)],
    ).slice(0, 4);
    return `${first}–${last}`;
  };
  const blockChunks = (variable: CubeVariable, b: number) =>
    Array.from(box.depth, (_, level) => level).flatMap((level) =>
      box.tiles.map(([tileLat, tileLon]) => {
        const indices = [b, level, tileLat, tileLon];
        return {
          url: source.chunkUrl(variable.name, indices),
          revision: source.chunkRevision(variable.name, indices),
        };
      }),
    );
  const modeVariables = () =>
    anomalyMode() ? [POTTMP, POTTMP_ANOM] : [POTTMP];
  const manager = new DataManager({
    button: $<HTMLButtonElement>("data"),
    store: chunkStore,
    prefix: url,
    facts: () => cubeFacts(anomalyMode()),
    blocks: () =>
      Array.from(
        { length: blockCount },
        (_, b): DataBlock => ({
          index: b,
          label: blockLabel(b),
          chunks: modeVariables().flatMap((variable) =>
            blockChunks(variable, b),
          ),
          all: [POTTMP, POTTMP_ANOM].flatMap((variable) =>
            blockChunks(variable, b).map((chunk) => chunk.url),
          ),
        }),
      ),
    // Read through ZarrSource, so the chunks land on disk; the block itself is dropped.
    download: async (b, onProgress) => {
      const variables = modeVariables();
      const perVariable = box.depth.length * box.tiles.length;
      const total = variables.length * perVariable;
      for (const [i, variable] of variables.entries()) {
        await loadBlock(
          source,
          variable,
          box,
          b,
          timeChunk,
          times.length,
          tile,
          (progress) => onProgress(i * perVariable + progress.done, total),
        );
      }
    },
    onChange: (complete) => {
      onDisk = complete;
      updateBlocks();
    },
  });
  void manager.refresh();

  // Sliders.
  const sliders = $("sliders");
  const sliderSpecs: Array<{
    key: keyof Cursor | "time";
    axis: string;
    name: string;
    min: number;
    max: number;
    step: number;
    text: (v: number) => string;
  }> = [
    {
      key: "lon",
      axis: "X",
      name: "LON (°)",
      min: space.west + 0.5,
      max: space.east - 0.5,
      step: 0.5,
      text: (v) => lonLabel(v, 1),
    },
    {
      key: "lat",
      axis: "Y",
      name: "LAT (°)",
      min: -14.5,
      max: 14.8,
      step: 1 / 3,
      text: (v) => latLabel(v, 1),
    },
    {
      key: "depth",
      axis: "Z",
      name: "DEPTH (m)",
      min: 0,
      max: BOTTOM,
      step: 5,
      text: (v) => `${Math.round(v)} m`,
    },
    {
      key: "time",
      axis: "T",
      name: "TIME",
      min: 0,
      max: lastMonth,
      step: 1,
      text: (v) => monthText(times[Math.round(v)]),
    },
  ];
  const inputs = new Map<
    string,
    {
      input: HTMLInputElement;
      value: HTMLOutputElement;
      text: (v: number) => string;
    }
  >();
  for (const spec of sliderSpecs) {
    const row = document.createElement("label");
    row.className = "slider";
    row.innerHTML = `<span class="axis">${spec.axis}</span><span class="name">${spec.name}</span>`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    const value = document.createElement("output");
    value.className = "chip";
    row.append(input, value);
    sliders.append(row);
    inputs.set(spec.key, { input, value, text: spec.text });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (spec.key === "time") {
        setMonth(Math.round(v));
      } else {
        setCursor({ [spec.key]: v });
      }
    });
  }
  const syncSliders = () => {
    const values: Record<string, number> = {
      ...cursor,
      time: Math.floor(month),
    };
    for (const [key, { input, value, text }] of inputs) {
      if (document.activeElement !== input) {
        input.value = String(values[key]);
      }
      value.textContent = text(values[key]);
    }
  };

  // Slices in 3D.
  const sliceLines = () => {
    const [x] = toWorld(space, cursor.lon, 0, 0);
    const [, y] = toWorld(space, space.west, cursor.lat, 0);
    const [, , z] = toWorld(space, space.west, 0, cursor.depth);
    const [hx, hy, hz] = space.half;
    const batch = new LineBatch();
    const rect = (corners: number[][]) => {
      for (let i = 0; i < 4; i++) {
        batch.segment(corners[i], corners[(i + 1) % 4]);
      }
    };
    rect([
      [x, -hy, -hz],
      [x, hy, -hz],
      [x, hy, hz],
      [x, -hy, hz],
    ]);
    rect([
      [-hx, y, -hz],
      [hx, y, -hz],
      [hx, y, hz],
      [-hx, y, hz],
    ]);
    rect([
      [-hx, -hy, z],
      [hx, -hy, z],
      [hx, hy, z],
      [-hx, hy, z],
    ]);
    renderer.setLines("slices", batch);
    return [x, y, z] as [number, number, number];
  };
  let sliceWorld = sliceLines();

  function setCursor(change: Partial<Cursor>): void {
    Object.assign(cursor, change);
    cursor.lon = Math.min(
      space.east - 0.5,
      Math.max(space.west + 0.5, cursor.lon),
    );
    cursor.lat = Math.min(space.north, Math.max(space.south, cursor.lat));
    cursor.depth = Math.min(BOTTOM, Math.max(0, cursor.depth));
    sliceWorld = sliceLines();
    syncSliders();
    drawPanels();
    writeHash();
    requestDraw();
  }

  /** The month, cursors, view preset and mode in the URL: #t=YYYY-MM&x=…&y=…&z=…&v=front&m=a. */
  function writeHash(): void {
    const parts = [
      `t=${monthText(times[Math.floor(month)])}`,
      `x=${cursor.lon.toFixed(1)}`,
      `y=${cursor.lat.toFixed(2)}`,
      `z=${Math.round(cursor.depth)}`,
      ...(preset ? [`v=${preset}`] : []),
      ...(anomalyMode() ? ["m=a"] : []),
      ...(capture ? ["capture"] : []),
    ];
    history.replaceState(null, "", `#${parts.join("&")}`);
  }

  /** Shows month `m` (integer) once its block is in memory. */
  async function setMonth(m: number): Promise<void> {
    month = Math.max(0, Math.min(lastMonth, m));
    const wanted = Math.floor(month);
    syncSliders();
    timeline.setMonth(month);
    writeHash();
    $("view-month").textContent = monthText(times[wanted]);
    $("time-chip").textContent = `t = ${monthText(times[wanted])}`;
    if (!cache.has(blockOf(wanted))) {
      updateBlocks();
      await cache.get(blockOf(wanted));
      updateBlocks();
      if (Math.floor(month) !== wanted) {
        return;
      }
    }
    status(null);
    if (shown !== wanted) {
      current = volumeOf(wanted);
      if (current) {
        renderer.setVolume(0, current);
        shown = wanted;
        nextMonth = -1;
        drawPanels();
      }
    }
    prepareNext();
    requestDraw();
  }

  /** Uploads the month after the shown one, if its block is in memory. */
  function prepareNext(): void {
    const next = shown + 1;
    if (next > lastMonth || nextMonth === next) {
      return;
    }
    const volume = volumeOf(next);
    if (volume) {
      renderer.setVolume(1, volume);
      nextMonth = next;
    } else if (!cache.loading(blockOf(next))) {
      cache.get(blockOf(next)).then(() => {
        updateBlocks();
        prepareNext();
      });
      updateBlocks();
    }
  }

  // Playback.
  const playButton = $("play");
  const setPlaying = (value: boolean) => {
    playing = value && month < lastMonth;
    icon(playButton, playing ? "pause" : "play");
    playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (!playing) {
      month = Math.floor(month);
      requestDraw();
    }
  };
  icon($("first"), "first");
  icon($("back"), "back");
  icon($("forward"), "forward");
  icon($("last"), "last");
  setPlaying(false);
  playButton.addEventListener("click", () => setPlaying(!playing));
  $("first").addEventListener("click", () => setMonth(0));
  $("last").addEventListener("click", () => setMonth(lastMonth));
  $("back").addEventListener("click", () => setMonth(Math.floor(month) - 1));
  $("forward").addEventListener("click", () => setMonth(Math.floor(month) + 1));
  $<HTMLSelectElement>("speed").addEventListener("change", (event) => {
    speed = Number((event.target as HTMLSelectElement).value);
  });
  window.addEventListener("keydown", (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      setPlaying(!playing);
    } else if (event.key === "ArrowLeft") {
      setMonth(Math.floor(month) - 1);
    } else if (event.key === "ArrowRight") {
      setMonth(Math.floor(month) + 1);
    }
  });

  // Display toggles.
  const toggles: Array<[string, keyof typeof show]> = [
    ["show-slices", "slices"],
    ["show-iso", "iso"],
    ["show-roi", "roi"],
    ["show-coast", "coast"],
    ["show-contours", "contours"],
  ];
  for (const [id, key] of toggles) {
    const input = $<HTMLInputElement>(id);
    input.checked = show[key];
    input.addEventListener("change", () => {
      show[key] = input.checked;
      drawPanels();
      requestDraw();
    });
  }
  const legend = $<HTMLCanvasElement>("legend");
  const drawLegend = () => {
    const [low, high] = domain();
    // Absolute: a tick every 2 °C, labelled every 4; anomaly: every 1, labelled every 2.
    const tick = anomalyMode() ? 1 : 2;
    $("legend-title").textContent = anomalyMode()
      ? "ANOMALY vs 1991–2020 (°C)"
      : "COLORMAP (°C)";
    const ratio = window.devicePixelRatio || 1;
    const rect = legend.getBoundingClientRect();
    legend.width = Math.round(rect.width * ratio);
    legend.height = Math.round(rect.height * ratio);
    const ctx = legend.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    // A horizontal bar, low on the left, ticks and labels under it.
    const barLeft = 8;
    const barWidth = Math.max(1, rect.width - 16);
    const barTop = 2;
    const barHeight = 10;
    for (let x = 0; x < barWidth; x++) {
      const [r, g, b] = rampColor(ramp, x / barWidth);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(barLeft + x, barTop, 1, barHeight);
    }
    ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = "rgba(235, 237, 240, 0.9)";
    ctx.strokeStyle = "rgba(235, 237, 240, 0.9)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let t = low; t <= high; t += tick) {
      const x = barLeft + ((t - low) / (high - low)) * barWidth;
      const labelled = t % (2 * tick) === 0;
      ctx.beginPath();
      ctx.moveTo(x, barTop + barHeight);
      ctx.lineTo(x, barTop + barHeight + (labelled ? 5 : 3));
      ctx.stroke();
      if (labelled) {
        ctx.fillText(
          anomalyMode() && t > 0 ? `+${t}` : String(t),
          x,
          barTop + barHeight + 6,
        );
      }
    }
  };
  const paletteButtons =
    document.querySelectorAll<HTMLButtonElement>("[data-palette]");
  /** The ramp of the mode: the chosen one for the temperature, balance for the anomaly. */
  const applyRamp = () => {
    ramp = rampBytes(anomalyMode() ? "balance" : palette);
    renderer.setPalette(ramp);
    for (const button of paletteButtons) {
      button.disabled = anomalyMode();
      button.setAttribute(
        "aria-pressed",
        String(!anomalyMode() && button.dataset.palette === palette),
      );
    }
    drawLegend();
    drawPanels();
    requestDraw();
  };
  for (const button of paletteButtons) {
    button.addEventListener("click", () => {
      palette = button.dataset.palette as PaletteName;
      applyRamp();
    });
  }
  const modeButtons =
    document.querySelectorAll<HTMLButtonElement>("[data-mode]");
  /** Switches the shown values; the month is shown again once the blocks it needs are read. */
  const setMode = (next: Mode) => {
    mode = next;
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    describe(anomalyMode());
    applyRamp();
    shown = -1;
    nextMonth = -1;
    // The blocks complete on disk depend on the mode's variables.
    void manager.refresh();
    void setMonth(Math.floor(month));
  };
  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.mode !== mode) {
        setMode(button.dataset.mode as Mode);
      }
    });
  }

  // Views.
  const setPreset = (next: Preset, animate = true) => {
    preset = next;
    transition = animate
      ? {
          from: { ...view },
          to: { ...PRESETS[next] },
          start: performance.now(),
        }
      : null;
    if (!animate) {
      view = { ...PRESETS[next] };
    }
    writeHash();
    $("view-name").textContent = PRESET_NAMES[next];
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-view]",
    )) {
      button.setAttribute("aria-pressed", String(button.dataset.view === next));
    }
    requestDraw();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-view]",
  )) {
    button.addEventListener("click", () =>
      setPreset(button.dataset.view as Preset),
    );
  }

  // Orbit, zoom and pick.
  const pointers = new Map<number, [number, number]>();
  let pinch = 0;
  const size = () => ({ width: stage.clientWidth, height: stage.clientHeight });
  /** The frame of the view, zoomed out on narrow stages so the box and its labels fit. */
  const fittedFrame = (width: number, height: number) => {
    const aspect = width / height;
    return frame(
      { ...view, zoom: view.zoom * Math.min(1, aspect / 1.15) },
      aspect,
    );
  };
  const freeView = () => {
    transition = null;
    if (preset) {
      preset = null;
      writeHash();
    }
    $("view-name").textContent = "3D FREE";
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-view]",
    )) {
      button.setAttribute("aria-pressed", "false");
    }
  };
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.offsetX, event.offsetY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      pick(event.offsetX, event.offsetY);
      return;
    }
    pointers.set(event.pointerId, [event.offsetX, event.offsetY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch > 0) {
        view.zoom = Math.min(4, Math.max(0.3, view.zoom * (distance / pinch)));
      }
      pinch = distance;
    } else {
      if (transition || view.oblique > 0) {
        view = { ...view, oblique: 0 };
      }
      freeView();
      view.yaw += (event.offsetX - previous[0]) * 0.008;
      view.pitch = Math.min(
        Math.PI / 2,
        Math.max(-0.2, view.pitch + (event.offsetY - previous[1]) * 0.008),
      );
    }
    requestDraw();
  });
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinch = 0;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("dblclick", () => setPreset("iso"));
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      view.zoom = Math.min(
        4,
        Math.max(0.3, view.zoom * Math.exp(-event.deltaY * 0.0015)),
      );
      requestDraw();
    },
    { passive: false },
  );

  /** Value under the pointer: the nearest slice plane hit, else the box face. */
  function pick(px: number, py: number): void {
    const { width, height } = size();
    if (!current || !width) {
      return;
    }
    const f = fittedFrame(width, height);
    const origin = unproject(f, px, py, width, height);
    const d = f.ray;
    const [hx, hy, hz] = space.half;
    const half = [hx, hy, hz];
    let near = -Infinity;
    let far = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (Math.abs(origin[i]) > half[i]) {
          near = Infinity;
        }
        continue;
      }
      const t1 = (-half[i] - origin[i]) / d[i];
      const t2 = (half[i] - origin[i]) / d[i];
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));
    }
    if (!(near <= far)) {
      $("pick").textContent = "PICK —";
      return;
    }
    let t = near;
    if (show.slices) {
      const hits = [0, 1, 2]
        .map((i) =>
          Math.abs(d[i]) > 1e-9 ? (sliceWorld[i] - origin[i]) / d[i] : Infinity,
        )
        .filter((hit) => hit >= near && hit <= far);
      if (hits.length) {
        t = Math.min(...hits);
      }
    }
    const point = [0, 1, 2].map((i) => origin[i] + d[i] * t);
    const [lon, lat, depth] = fromWorld(space, point);
    const { cols, rows, steps, values, anomaly } = current;
    const c = Math.min(
      cols - 1,
      Math.max(
        0,
        Math.floor(((lon - space.west) / (space.east - space.west)) * cols),
      ),
    );
    const r = Math.min(
      rows - 1,
      Math.max(
        0,
        Math.floor(((lat - space.south) / (space.north - space.south)) * rows),
      ),
    );
    const s = Math.min(
      steps - 1,
      Math.max(0, Math.round((depth / BOTTOM) * (steps - 1))),
    );
    const value = values[(s * rows + r) * cols + c];
    const departure = anomaly?.[(s * rows + r) * cols + c];
    const text = Number.isNaN(value)
      ? "land / sea floor"
      : departure === undefined || Number.isNaN(departure)
        ? `${value.toFixed(2)} °C`
        : `${departure >= 0 ? "+" : ""}${departure.toFixed(2)} °C (${value.toFixed(2)} °C)`;
    $("pick").textContent =
      `PICK ${lonLabel(lon, 1)} · ${latLabel(lat, 1)} · ${Math.round(depth)} m · ${text}`;
  }

  // Layout.
  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const { width, height } = size();
    renderer.resize(Math.round(width * ratio), Math.round(height * ratio));
    for (const panel of panels.values()) {
      panel.resize();
    }
    timeline.resize();
    drawLegend();
    requestDraw();
  };
  new ResizeObserver(resize).observe(document.body);

  // Loop.
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (transition) {
      const t = Math.min(1, (now - transition.start) / 600);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      view = blendViews(transition.from, transition.to, eased);
      if (t >= 1) {
        transition = null;
      }
      dirty = true;
    }
    if (playing) {
      const target = month + dt * speed;
      const whole = Math.floor(month);
      if (Math.floor(target) > whole) {
        if (nextMonth === whole + 1) {
          // The next month becomes the shown one.
          renderer.swapVolumes();
          shown = whole + 1;
          current = volumeOf(shown);
          nextMonth = -1;
          month = Math.min(target, shown + 0.999);
          prepareNext();
          drawPanels();
          syncSliders();
          $("view-month").textContent = monthText(times[shown]);
          $("time-chip").textContent = `t = ${monthText(times[shown])}`;
          if (
            shown % timeChunk >= timeChunk - 12 &&
            blockOf(shown) + 1 <= blockOf(lastMonth)
          ) {
            cache.get(blockOf(shown) + 1).then(updateBlocks);
          }
          if (shown >= lastMonth) {
            setPlaying(false);
          }
        } else {
          // Wait for the next block.
          month = whole + 0.999;
          prepareNext();
        }
      } else {
        month = target;
      }
      timeline.setMonth(month);
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      const { width, height } = size();
      if (width > 0 && height > 0) {
        const f = fittedFrame(width, height);
        const mix =
          captureMix ??
          (playing && nextMonth === Math.floor(month) + 1
            ? month - Math.floor(month)
            : 0);
        renderer.render(f, {
          slice: sliceWorld,
          show,
          mix,
          domain: domain(),
          anomaly: anomalyMode(),
          iso: ISO,
          bottom: BOTTOM,
          step: width < MOBILE ? 0.012 : 0.006,
        });
        if (labels.update(f, width, height, show)) {
          renderer.setLines("ticks", labels.ticks());
          dirty = true;
        }
      }
    }
    requestAnimationFrame(loop);
  };

  syncSliders();
  updateBlocks();
  resize();
  requestAnimationFrame(loop);
  // #t=YYYY-MM&x=…&y=…&z=…&v=…&m=a opens that month, cursors, view and mode; the last month otherwise.
  const param = (key: string) =>
    new RegExp(`[#&]${key}=([^&]+)`).exec(location.hash)?.[1];
  // Read everything first: applying the cursors rewrites the hash.
  const shared = param("t");
  const sharedPreset = param("v");
  if (param("m") === "a") {
    mode = "anomaly";
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    describe(true);
    applyRamp();
  }
  const sharedMonth = shared
    ? Array.from(times, monthText).indexOf(shared)
    : -1;
  const sharedCursor: Partial<Cursor> = {};
  for (const [key, field] of [
    ["x", "lon"],
    ["y", "lat"],
    ["z", "depth"],
  ] as const) {
    const value = Number(param(key));
    if (param(key) !== undefined && Number.isFinite(value)) {
      sharedCursor[field] = value;
    }
  }
  setCursor(sharedCursor);
  if (sharedPreset && sharedPreset in PRESETS) {
    setPreset(sharedPreset as Preset, false);
  }
  await setMonth(sharedMonth >= 0 ? sharedMonth : lastMonth);

  if (capture) {
    /**
     * Shows month `m` of the store's time axis, fractional parts blending into the next
     * month as in playback, and resolves once that frame is drawn.
     */
    const frame = async (m: number) => {
      const whole = Math.max(0, Math.min(lastMonth, Math.floor(m)));
      await setMonth(whole);
      if (whole < lastMonth) {
        await cache.get(blockOf(whole + 1));
        prepareNext();
      }
      captureMix = nextMonth === whole + 1 ? m - whole : 0;
      month = m;
      timeline.setMonth(m);
      requestDraw();
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    };
    const index = (text: string) => Array.from(times, monthText).indexOf(text);
    Object.assign(window, { cubeCapture: { frame, index, lastMonth } });
  }
}

main().catch((error: unknown) => {
  const loading = document.getElementById("loading");
  if (loading) {
    loading.hidden = false;
    loading.textContent = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
  console.error(error);
});
