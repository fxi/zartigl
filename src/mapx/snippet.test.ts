import { describe, expect, it } from "vitest";
import {
  buildMapxWidgetSnippet,
  buildStandaloneDemoSnippet,
} from "./snippet";
import pkg from "../../package.json";

describe("buildMapxWidgetSnippet", () => {
  it("builds a MapX widget handler using the ARCO extension", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "b15be4e7-94ca-4887-a874-3fab37d29638",
      layerKind: "vector",
      source: "zarr",
      time: new Date("2026-06-04T00:00:00.000Z"),
      depth: 10,
      timeRange: { trailing: "P1M" },
      geoVideo: { autoplay: false, loop: true, playbackRate: 2 },
      settings: {
        palette: "rdylbu",
        opacity: 0.8,
        speed: 1.0,
        renderMode: "raster+particles",
      },
    });

    expect(snippet).toContain("function handler()");
    expect(snippet).toContain("moduleLoad");
    expect(snippet).toContain("\"arco_time_map_legend\"");
    expect(snippet).toContain("const local = {");
    expect(snippet).toContain("arco: null");
    expect(snippet).toContain("const elLegend = getViewLegend(widget.opt.view, { clone: false })");
    expect(snippet).toContain("local.arco = new ArcoMapLegend({");
    expect(snippet).toContain("await local.arco.init()");
    expect(snippet).toContain("elInputs: widget.elContent");
    expect(snippet).toContain("source: \"zarr\"");
    expect(snippet).toContain("layer: \"b15be4e7-94ca-4887-a874-3fab37d29638\"");
    expect(snippet).toContain("settings: {");
    expect(snippet).toContain("\"opacity\": 0.8");
    expect(snippet).toContain('"renderMode": "raster+particles"');
    expect(snippet).toContain("time: new Date(\"2026-06-04T00:00:00.000Z\")");
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

  it("omits particle-only settings from scalar GeoVideo snippets", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "sea-temperature",
      layerKind: "scalar",
      source: "geovideo",
      settings: {
        palette: "balance",
        opacity: 0.8,
        logScale: false,
        vibrance: 0.2,
        colorDomain: [-3, 3],
        particleDensity: 0.05,
        speed: 1,
        fade: 0.7,
        renderMode: "particles",
      },
    });

    expect(snippet).toContain('source: "geovideo"');
    expect(snippet).toContain('"palette": "balance"');
    expect(snippet).toContain('"colorDomain"');
    expect(snippet).not.toContain("particleDensity");
    expect(snippet).not.toContain('"speed"');
    expect(snippet).not.toContain('"fade"');
    expect(snippet).not.toContain("renderMode");
  });
});

describe("buildStandaloneDemoSnippet", () => {
  it("builds a standalone zartigl script for external demos", () => {
    const snippet = buildStandaloneDemoSnippet({
      layerId: "b15be4e7-94ca-4887-a874-3fab37d29638",
      layerKind: "scalar",
      source: "wmts",
      time: new Date("2026-06-04T00:00:00.000Z"),
      timeRange: { start: "2026-06-01T00:00:00Z", end: "2026-06-30T00:00:00Z" },
      geoVideo: { autoplay: true, loop: false, playbackRate: 5 },
      depth: 10,
      settings: { opacity: 0.8, renderMode: "raster" },
      center: [6.1, 46.2],
      zoom: 4.1234,
      bearing: 12.5,
      pitch: 20,
      projection: "globe",
    });

    expect(snippet).toContain("import { Zartigl }");
    expect(snippet).toContain("new maplibregl.Map({");
    expect(snippet).toContain("center: [6.1, 46.2]");
    expect(snippet).toContain("zoom: 4.123");
    expect(snippet).toContain("map.setProjection({ type: \"globe\" })");
    expect(snippet).toContain("new Zartigl({");
    expect(snippet).toContain("source: \"wmts\"");
    expect(snippet).toContain('"start": "2026-06-01T00:00:00Z"');
    expect(snippet).toContain("geoVideo: {");
    expect(snippet).toContain("await z.setLayer(\"b15be4e7-94ca-4887-a874-3fab37d29638\")");
    expect(snippet).toContain("z.updateSettings({");
    expect(snippet).toContain('"opacity": 0.8');
    expect(snippet).not.toContain("renderMode");
    expect(snippet).toContain("z.setTimeAndDepth(new Date(\"2026-06-04T00:00:00.000Z\"), 10)");
  });

  it("pins the default module URL to the current package version", () => {
    const snippet = buildStandaloneDemoSnippet({
      layerId: "layer",
      layerKind: "scalar",
    });

    expect(snippet).toContain(`@fxi/zartigl@${pkg.version}/dist`);
  });
});
