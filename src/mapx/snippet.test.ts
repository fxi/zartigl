import { describe, expect, it } from "vitest";
import {
  buildMapxWidgetSnippet,
  buildStandaloneDemoHtml,
  buildStandaloneDemoSnippet,
} from "./snippet";
import pkg from "../../package.json";

const maplibreVersion = pkg.devDependencies["maplibre-gl"].replace(
  /^[^\d]*/,
  "",
);

describe("buildMapxWidgetSnippet", () => {
  it("builds a MapX widget handler using the ARCO extension", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "b15be4e7-94ca-4887-a874-3fab37d29638",
      layerKind: "vector",
      layerDefaults: {},
      source: "zarr",
      time: new Date("2026-06-04T00:00:00.000Z"),
      depth: 10,
      timeRange: { trailing: "P1M" },
      geoVideo: { autoplay: false, loop: true, playbackRate: 2 },
      style: {
        palette: "rdylbu",
        renderMode: "raster+particles",
        particles: { speed: 1.0 },
        raster: { opacity: 0.8 },
      },
      settings: { particleState: "rgba8" },
    });

    expect(snippet).toContain("function handler()");
    expect(snippet).toContain("moduleLoad");
    expect(snippet).toContain('"arco_time_map_legend"');
    expect(snippet).toContain("const local = {");
    expect(snippet).toContain("arco: null");
    expect(snippet).toContain(
      "const elLegend = getViewLegend(widget.opt.view, { clone: false })",
    );
    expect(snippet).toContain("local.arco = new ArcoMapLegend({");
    expect(snippet).toContain("await local.arco.init()");
    expect(snippet).toContain("elInputs: widget.elContent");
    expect(snippet).toContain('source: "zarr"');
    expect(snippet).toContain('layer: "b15be4e7-94ca-4887-a874-3fab37d29638"');
    expect(snippet).toContain("style: {");
    expect(snippet).toContain('"opacity": 0.8');
    expect(snippet).toContain('"renderMode": "raster+particles"');
    // Same as the layer's own style: left out.
    expect(snippet).not.toContain('"speed"');
    expect(snippet).toContain("settings: {");
    expect(snippet).toContain('"particleState": "rgba8"');
    expect(snippet).not.toContain("particleDensity");
    expect(snippet).toContain('time: new Date("2026-06-04T00:00:00.000Z")');
    expect(snippet).toContain("depth: 10");
    expect(snippet).toContain('"trailing": "P1M"');
    expect(snippet).toContain("geoVideo: {");
    expect(snippet).toContain('"playbackRate": 2');
    expect(snippet).not.toMatch(/\n\s+(autoplay|loop|playbackRate):/);
    expect(snippet).toContain("local.arco?.destroy()");
    expect(snippet).toContain("local.arco = null");
    expect(snippet).not.toContain("widget._arco");
  });

  it("does not use the direct zartigl API in MapX widget code", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "scalar",
      layerKind: "scalar",
    });

    expect(snippet).not.toContain("new Zartigl({");
    expect(snippet).not.toContain("cc._zartigl");
  });

  it("serializes a start-only time range", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "scalar",
      layerKind: "scalar",
      timeRange: { start: "2026-01-01T00:00:00Z" },
    });

    expect(snippet).toContain('"start": "2026-01-01T00:00:00Z"');
    expect(snippet).not.toContain('"end"');
  });

  it("writes only the style a scalar layer draws, over its own", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "sea-temperature",
      layerKind: "scalar",
      layerDefaults: { palette: "thermal", raster: { vibrance: 0.2 } },
      source: "geovideo",
      style: {
        palette: "balance",
        renderMode: "particles",
        particles: { density: 0.05, speed: 1, fade: 0.7 },
        raster: {
          opacity: 0.8,
          logScale: false,
          vibrance: 0.2,
          colorDomain: [-3, 3],
        },
      },
      settings: { particleState: "rgba8" },
    });

    expect(snippet).toContain('source: "geovideo"');
    expect(snippet).toContain('"palette": "balance"');
    expect(snippet).toContain('"colorDomain"');
    expect(snippet).toContain('"opacity": 0.8');
    expect(snippet).not.toContain("particles");
    expect(snippet).not.toContain("renderMode");
    expect(snippet).not.toContain("logScale");
    expect(snippet).not.toContain("vibrance");
    expect(snippet).not.toContain("settings:");
  });

  it("writes the whole override when the layer's own style is unknown", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "ocean-current-velocity",
      layerKind: "vector",
      style: { particles: { density: 0.05 } },
    });

    expect(snippet).toContain('"density": 0.05');
  });

  it("writes no style when the layer keeps its own", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "wind",
      layerKind: "vector",
      layerDefaults: { palette: "thermal", particles: { density: 0.03 } },
      style: { palette: "thermal", particles: { density: 0.03 } },
    });

    expect(snippet).not.toContain("style:");
  });

  it("writes a reversed palette and alpha fades when they differ", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "fire-radiative-power",
      layerKind: "scalar",
      layerDefaults: { palette: "amp", raster: { alphaFadeLow: 0.1 } },
      style: {
        palette: "amp",
        reversePalette: true,
        raster: { alphaFadeLow: 0.1, alphaFadeHigh: 0.2 },
      },
    });

    expect(snippet).toContain('"reversePalette": true');
    expect(snippet).toContain('"alphaFadeHigh": 0.2');
    expect(snippet).not.toContain("alphaFadeLow");
  });
});

describe("buildStandaloneDemoSnippet", () => {
  it("builds a standalone zartigl script for external demos", () => {
    const snippet = buildStandaloneDemoSnippet({
      layerId: "b15be4e7-94ca-4887-a874-3fab37d29638",
      layerKind: "scalar",
      source: "45adba3a-c538-4507-a25c-9c034fb9a02b",
      sourceType: "wmts",
      time: new Date("2026-06-04T00:00:00.000Z"),
      timeRange: { start: "2026-06-01T00:00:00Z", end: "2026-06-30T00:00:00Z" },
      geoVideo: { autoplay: true, loop: false, playbackRate: 5 },
      depth: 10,
      style: { renderMode: "raster", raster: { opacity: 0.8, vibrance: 1 } },
      center: [6.1, 46.2],
      zoom: 4.1234,
      bearing: 12.5,
      pitch: 20,
      projection: "globe",
    });

    expect(snippet).toContain("import { Zartigl }");
    expect(snippet).toContain(
      `import maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@${maplibreVersion}/+esm"`,
    );
    expect(snippet).toContain("new maplibregl.Map({");
    expect(snippet).toContain("s2cloudless-2025_3857");
    expect(snippet).toContain(
      'EOxCloudless <a href="https://cloudless.eox.at">',
    );
    expect(snippet).toContain(
      '<a href="https://eox.at">EOX IT Services GmbH</a>',
    );
    expect(snippet).toContain('map.once("style.load", async () => {');
    expect(snippet).toContain("map.jumpTo({");
    expect(snippet).toContain("center: [6.1, 46.2]");
    expect(snippet).toContain("zoom: 4.123");
    expect(snippet).toContain("bearing: 12.5");
    expect(snippet).toContain("pitch: 20");
    expect(snippet).toContain('map.setProjection({ type: "globe" })');
    expect(snippet).toContain("map.setSky({");
    expect(snippet).toContain('"sky-color": "#05070f"');
    expect(snippet).toContain("new Zartigl({");
    expect(snippet).toContain('source: "45adba3a-c538-4507-a25c-9c034fb9a02b"');
    expect(snippet).toContain('"start": "2026-06-01T00:00:00Z"');
    expect(snippet).toContain("geoVideo: {");
    expect(snippet).toContain('layer: "b15be4e7-94ca-4887-a874-3fab37d29638"');
    expect(snippet).toContain("style: {");
    expect(snippet).toContain('"opacity": 0.8');
    // WMTS only takes its opacity.
    expect(snippet).not.toContain("vibrance");
    expect(snippet).not.toContain("renderMode");
    expect(snippet).toContain('time: new Date("2026-06-04T00:00:00.000Z")');
    expect(snippet).toContain("depth: 10");
    expect(snippet).toContain("await z.init()");
    expect(snippet.indexOf('map.once("style.load"')).toBeLessThan(
      snippet.indexOf('map.setProjection({ type: "globe" })'),
    );
    expect(
      snippet.indexOf('map.setProjection({ type: "globe" })'),
    ).toBeLessThan(snippet.indexOf("map.jumpTo({"));
    expect(snippet.indexOf("map.jumpTo({")).toBeLessThan(
      snippet.indexOf("new Zartigl({"),
    );
  });

  it("takes a MapLibre map style URL", () => {
    const snippet = buildStandaloneDemoSnippet({
      layerId: "61a81ddd-6c8e-4020-a59f-06ef13a90419",
      layerKind: "scalar",
      mapStyle: "https://example.test/style.json",
    });

    expect(snippet).toContain(
      'const style = "https://example.test/style.json";',
    );
  });

  it("pins the default module URL to the current package version", () => {
    const snippet = buildStandaloneDemoSnippet({
      layerId: "61a81ddd-6c8e-4020-a59f-06ef13a90419",
      layerKind: "scalar",
    });

    expect(snippet).toContain(`@fxi/zartigl@${pkg.version}/dist`);
  });

  it("serializes an end-only time range", () => {
    const snippet = buildStandaloneDemoSnippet({
      layerId: "39296bd8-f93f-4fce-91ab-44faf9d91e90",
      layerKind: "scalar",
      timeRange: { end: "2026-06-30T00:00:00Z" },
    });

    expect(snippet).toContain('"end": "2026-06-30T00:00:00Z"');
    expect(snippet).not.toContain('"start"');
  });
});

describe("buildStandaloneDemoHtml", () => {
  it("wraps the generated script in a full-viewport HTML document", () => {
    const options = {
      layerId: "61a81ddd-6c8e-4020-a59f-06ef13a90419",
      layerKind: "vector" as const,
      source: "5e677cff-e789-47d6-bdc0-c92af3c7fbe7",
      sourceType: "zarr" as const,
      center: [6.1, 46.2] as [number, number],
      projection: "globe" as const,
    };
    const html = buildStandaloneDemoHtml(options);
    const script = buildStandaloneDemoSnippet(options);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("html, body, #map");
    expect(html).toContain("width: 100%");
    expect(html).toContain("height: 100%");
    expect(html).toContain("background: radial-gradient(");
    expect(html).toContain('<div id="map"></div>');
    expect(html).toContain('<script type="module">');
    expect(html).toContain(script);
    expect(html).toContain(
      `maplibre-gl@${maplibreVersion}/dist/maplibre-gl.css`,
    );
  });
});
