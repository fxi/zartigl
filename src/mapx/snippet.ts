import type { ZartiglSettings } from "../lib/Zartigl";

export interface MapxWidgetSnippetOptions {
  layerId: string;
  backend?: "auto" | "zarr" | "wmts";
  time?: string | number | Date;
  depth?: number;
  settings?: Partial<ZartiglSettings>;
}

export interface StandaloneDemoSnippetOptions extends MapxWidgetSnippetOptions {
  moduleBaseUrl?: string;
  center?: [number, number];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  projection?: "mercator" | "globe";
  style?: string;
}

function codeString(value: string): string {
  return JSON.stringify(value);
}

function codeValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function codeTime(value: string | number | Date): string {
  if (value instanceof Date) return `new Date(${codeString(value.toISOString())})`;
  if (typeof value === "string") return `new Date(${codeString(value)})`;
  return String(value);
}

function codeNumber(value: number, digits = 6): string {
  return String(Number(value.toFixed(digits)));
}

function indentedValue(value: unknown, spaces: number): string {
  const pad = " ".repeat(spaces);
  return codeValue(value)
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n")
    .trimStart();
}

function standaloneSettingsBlock(settings?: Partial<ZartiglSettings>): string {
  if (!settings || Object.keys(settings).length === 0) return "";
  const body = indentedValue(settings, 2);
  return `\n      z.updateSettings(${body});`;
}

export function buildMapxWidgetSnippet(options: MapxWidgetSnippetOptions): string {
  const optionLines = [
    "        idView: widget.opt.view.id,",
    "        map: widget.opt.map,",
    `        layer: ${codeString(options.layerId)},`,
    `        backend: ${codeString(options.backend ?? "auto")},`,
  ];

  if (options.settings && Object.keys(options.settings).length > 0) {
    optionLines.push(`        settings: ${indentedValue(options.settings, 10)},`);
  }
  if (options.time != null) {
    optionLines.push(`        time: ${codeTime(options.time)},`);
  }
  if (options.depth != null) {
    optionLines.push(`        depth: ${options.depth},`);
  }

  optionLines.push(
    "        elLegend: elLegend,",
    "        elInputs: widget.elContent,",
  );

  return `function handler() {
  const { moduleLoad, getViewLegend } = mx.helpers;

  const widget_config = {
    onAdd: async function (widget) {
      const { ArcoMapLegend } = await moduleLoad(
        "extension",
        "arco_time_map_legend",
      );

      const elLegend = getViewLegend(widget.opt.view, { clone: false });

      widget._arco = new ArcoMapLegend({
${optionLines.join("\n")}
      });

      await widget._arco.init();
    },

    onRemove: async function (widget) {
      widget?._arco?.destroy();
    },

    onData: async function () {},
  };

  return widget_config;
}`;
}

export function buildStandaloneDemoSnippet(options: StandaloneDemoSnippetOptions): string {
  const moduleBaseUrl =
    options.moduleBaseUrl ?? "https://cdn.jsdelivr.net/npm/@fxi/zartigl@0.2.1/dist";
  const backend = options.backend ?? "auto";
  const setTimeLine = options.time == null
    ? ""
    : options.depth == null
      ? `\n      z.setTime(${codeTime(options.time)});`
      : `\n      z.setTimeAndDepth(${codeTime(options.time)}, ${options.depth});`;
  const center = options.center ?? [0, 20];
  const projection = options.projection ?? "mercator";
  const style = options.style ?? "https://demotiles.maplibre.org/style.json";

  return `import maplibregl from "maplibre-gl";
import { Zartigl } from "${moduleBaseUrl}/zartigl.js";
import { catalog } from "${moduleBaseUrl}/catalog.js";

const map = new maplibregl.Map({
  container: "map",
  style: ${codeString(style)},
  center: [${codeNumber(center[0])}, ${codeNumber(center[1])}],
  zoom: ${codeNumber(options.zoom ?? 2, 3)},
  bearing: ${codeNumber(options.bearing ?? 0, 3)},
  pitch: ${codeNumber(options.pitch ?? 0, 3)},
});
map.setProjection({ type: ${codeString(projection)} });

const z = new Zartigl({
  id: "zartigl-demo",
  map,
  catalog,
  backend: ${codeString(backend)},
});

await z.setLayer(${codeString(options.layerId)});${standaloneSettingsBlock(options.settings)}${setTimeLine}`;
}
