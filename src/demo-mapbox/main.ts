import mapboxgl from "mapbox-gl";
import "../demo/style.css";
import { Pane } from "tweakpane";
import type { BindingApi, FolderApi } from "@tweakpane/core";
import { ParticleLayer, getPalettes } from "../lib/index.js";
import type { RenderMode } from "../lib/ParticleSimulation.js";
import type { FieldMeta } from "../lib/index.js";
import { TimelinePlayer } from "../demo-shared/TimelinePlayer.js";
import type { CatalogView, Catalog } from "../demo-shared/catalog.js";
import { formatTime, formatVertical, getVerticalDim } from "../demo-shared/catalog.js";

// ── Helpers ───────────────────────────────────────────────────────────

function showToast(msg: string) {
  const t = document.createElement("div");
  t.className = "copy-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

async function loadCatalog(): Promise<Catalog> {
  const resp = await fetch(`${import.meta.env.BASE_URL}data/catalog.json`);
  if (!resp.ok) throw new Error(`Failed to load catalog: ${resp.status}`);
  return resp.json();
}

// ── Map setup — mapbox-gl ─────────────────────────────────────────────

mapboxgl.accessToken = import.meta.env.MAPBOX_TOKEN as string;

const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/dark-v11",
  center: [0, 20],
  zoom: 2,
  maxZoom: 8,
  projection: { name: "mercator" },
});

// ── Init ──────────────────────────────────────────────────────────────

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
    let suppressSliderChange = false;

    // DOM element refs
    let paletteSelectEl: HTMLSelectElement | null = null;
    let viewSelectEl: HTMLSelectElement | null = null;
    let renderModeButtons: { mode: RenderMode; btn: HTMLButtonElement }[] = [];

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

    // ── Legend DOM ─────────────────────────────────────────────────

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

    function refreshUI() {
      if (paletteSelectEl) paletteSelectEl.value = currentPaletteId;
      if (viewSelectEl) viewSelectEl.value = String(PARAMS.viewIndex);
      const isScalar = currentView?.type === "scalar";
      for (const { mode, btn } of renderModeButtons) {
        btn.classList.toggle("active", mode === currentRenderMode);
        btn.disabled = isScalar && mode !== "raster";
      }
      pane.refresh();
      updateStandaloneLegendGradient();
    }

    // ── View meta element ──────────────────────────────────────────

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

    // View selector — grouped by category
    if (catalog.views.length > 1) {
      const viewFolder = pane.addFolder({ title: "View" }) as FolderApi;

      const viewSelect = document.createElement("select");
      viewSelect.className = "view-select";

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

    // ── Data folder (rebuilt on view switch) ───────────────────────

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

        const isVector = view.type === "vector";
        const frameMs = isVector ? 2000 : 200;
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
      const vertValues = [...(vertEntry?.[1].values ?? [0])].sort((a, b) => a - b);

      applyDefaults(view);
      PARAMS.timeIndex = (timeDim.size ?? 1) - 1;
      PARAMS.timeLabel = formatTime(timeMin + PARAMS.timeIndex * timeStep);
      PARAMS.vertical = vertValues[0] ?? 0;

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

      map.addLayer(layer as unknown as mapboxgl.CustomLayerInterface);
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

    // ── Initial view ───────────────────────────────────────────────

    switchView(catalog.views[0]);

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

    // ── Wire legend ────────────────────────────────────────────────

    layerEventHandlers.onLoaded = updateStandaloneLegendMeta;
    layer.on("loaded", updateStandaloneLegendMeta);
    updateStandaloneLegendGradient();

  } catch (err) {
    console.error("Failed to initialize:", err);
  }
});
