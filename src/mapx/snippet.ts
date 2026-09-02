import type { GeoVideoOptions, TimeRange, ZartiglSettings } from "../lib/Zartigl";
import type { CatalogEntry } from "../catalog/types";
import pkg from "../../package.json";

type SnippetSourceType = "zarr" | "geovideo" | "wmts";

export interface MapxWidgetSnippetOptions {
  layerId: string;
  layerKind: CatalogEntry["kind"];
  source?: string;
  sourceType?: SnippetSourceType;
  time?: string | number | Date;
  timeRange?: TimeRange;
  geoVideo?: GeoVideoOptions;
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

const maplibreVersion = pkg.devDependencies["maplibre-gl"].replace(/^[^\d]*/, "");
const maplibreModuleUrl =
  `https://cdn.jsdelivr.net/npm/maplibre-gl@${maplibreVersion}/+esm`;
const maplibreCssUrl =
  `https://cdn.jsdelivr.net/npm/maplibre-gl@${maplibreVersion}/dist/maplibre-gl.css`;

const eoxCloudlessStyle = `{
  version: 8,
  sources: {
    "eox-cloudless": {
      type: "raster",
      tiles: [
        "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg"
      ],
      tileSize: 256,
      maxzoom: 14,
      attribution: 'EOxCloudless <a href="https://cloudless.eox.at">https://cloudless.eox.at</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2025)'
    }
  },
  layers: [
    {
      id: "eox-cloudless",
      type: "raster",
      source: "eox-cloudless"
    }
  ]
}`;

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

function indentBlock(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => line.length > 0 ? `${pad}${line}` : line)
    .join("\n");
}

function pickSettings(
  settings: Partial<ZartiglSettings>,
  keys: Array<keyof ZartiglSettings>,
): Partial<ZartiglSettings> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(settings, key))
      .map((key) => [key, settings[key]]),
  ) as Partial<ZartiglSettings>;
}

/** Keep only settings supported by the selected layer and transport. */
export function effectiveSnippetSettings(
  layerKind: CatalogEntry["kind"],
  sourceType: SnippetSourceType,
  settings?: Partial<ZartiglSettings>,
): Partial<ZartiglSettings> | undefined {
  if (!settings) return undefined;
  const keys: Array<keyof ZartiglSettings> = layerKind === "vector"
    ? [
        "palette",
        "opacity",
        "logScale",
        "vibrance",
        "particleDensity",
        "speed",
        "fade",
        "renderMode",
        "particleState",
        "rgba8MaxParticleZoom",
      ]
    : sourceType === "wmts"
      ? ["opacity"]
      : ["palette", "opacity", "logScale", "vibrance", "colorDomain"];
  const effective = pickSettings(settings, keys);
  return Object.keys(effective).length > 0 ? effective : undefined;
}

export function buildMapxWidgetSnippet(options: MapxWidgetSnippetOptions): string {
  const source = options.source ?? "auto";
  const settings = effectiveSnippetSettings(
    options.layerKind,
    options.sourceType ?? (source === "wmts" || source === "geovideo" ? source : "zarr"),
    options.settings,
  );
  const optionLines = [
    "        idView: widget.opt.view.id,",
    "        map: widget.opt.map,",
    `        layer: ${codeString(options.layerId)},`,
    `        source: ${codeString(source)},`,
  ];

  if (settings) {
    optionLines.push(`        settings: ${indentedValue(settings, 10)},`);
  }
  if (options.time != null) {
    optionLines.push(`        time: ${codeTime(options.time)},`);
  }
  if (options.timeRange != null) {
    optionLines.push(`        timeRange: ${indentedValue(options.timeRange, 10)},`);
  }
  if (options.geoVideo != null) {
    optionLines.push(`        geoVideo: ${indentedValue(options.geoVideo, 10)},`);
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
  const local = {
    arco: null,
  };

  return {
    onAdd: async function (widget) {
      const { ArcoMapLegend } = await moduleLoad(
        "extension",
        "arco_time_map_legend",
      );

      const elLegend = getViewLegend(widget.opt.view, { clone: false });

      local.arco = new ArcoMapLegend({
${optionLines.join("\n")}
      });

      await local.arco.init();
    },

    onRemove: function () {
      local.arco?.destroy();
      local.arco = null;
    },

    onData: async function () {},
  };
}`;
}

export function buildStandaloneDemoSnippet(options: StandaloneDemoSnippetOptions): string {
  const moduleBaseUrl =
    options.moduleBaseUrl ?? `https://cdn.jsdelivr.net/npm/@fxi/zartigl@${pkg.version}/dist`;
  const source = options.source ?? "auto";
  const settings = effectiveSnippetSettings(
    options.layerKind,
    options.sourceType ?? (source === "wmts" || source === "geovideo" ? source : "zarr"),
    options.settings,
  );
  const timeRangeLine = options.timeRange == null
    ? ""
    : `  timeRange: ${indentedValue(options.timeRange, 2)},\n`;
  const geoVideoLine = options.geoVideo == null
    ? ""
    : `  geoVideo: ${indentedValue(options.geoVideo, 2)},\n`;
  const settingsLine = settings == null
    ? ""
    : `  settings: ${indentedValue(settings, 2)},\n`;
  const timeLine = options.time == null ? "" : `  time: ${codeTime(options.time)},\n`;
  const depthLine = options.depth == null ? "" : `  depth: ${options.depth},\n`;
  const center = options.center ?? [0, 20];
  const projection = options.projection ?? "mercator";
  const style = options.style == null ? eoxCloudlessStyle : codeString(options.style);
  const runtime = `map.setProjection({ type: ${codeString(projection)} });
map.jumpTo({
  center: [${codeNumber(center[0])}, ${codeNumber(center[1])}],
  zoom: ${codeNumber(options.zoom ?? 2, 3)},
  bearing: ${codeNumber(options.bearing ?? 0, 3)},
  pitch: ${codeNumber(options.pitch ?? 0, 3)},
});
map.setSky({
  "sky-color": "#05070f",
  "horizon-color": "#172033",
  "fog-color": "#0b1020",
  "sky-horizon-blend": 0.45,
  "horizon-fog-blend": 0.65,
  "atmosphere-blend": [
    "interpolate",
    ["linear"],
    ["zoom"],
    0, 1,
    5, 0.65,
    8, 0
  ],
});

const z = new Zartigl({
  id: "zartigl-demo",
  map,
  catalog,
  layer: ${codeString(options.layerId)},
  source: ${codeString(source)},
${timeRangeLine}${geoVideoLine}${settingsLine}${timeLine}${depthLine}});

await z.init();`;

  return `import maplibregl from ${codeString(maplibreModuleUrl)};
import { Zartigl } from "${moduleBaseUrl}/zartigl.js";
import { catalog } from "${moduleBaseUrl}/catalog.js";

const style = ${style};

const map = new maplibregl.Map({
  container: "map",
  style,
});

map.once("style.load", async () => {
${indentBlock(runtime, 2)}
});`;
}

export function buildStandaloneDemoHtml(options: StandaloneDemoSnippetOptions): string {
  const script = buildStandaloneDemoSnippet(options);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zartigl demo</title>
    <link rel="stylesheet" href=${codeString(maplibreCssUrl)} />
    <style>
      html, body, #map {
        width: 100%;
        height: 100%;
        margin: 0;
      }
      body {
        background: radial-gradient(circle at 50% 45%, #172033 0%, #080b14 48%, #000 100%);
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script type="module">
${script}
    </script>
  </body>
</html>`;
}
