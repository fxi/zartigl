import { describe, expect, it } from "vitest";
import {
  buildMapxWidgetSnippet,
  buildStandaloneDemoSnippet,
} from "./snippet";

describe("buildMapxWidgetSnippet", () => {
  it("builds a MapX widget handler using the ARCO extension", () => {
    const snippet = buildMapxWidgetSnippet({
      layerId: "surface-wind",
      backend: "zarr",
      time: new Date("2026-06-04T00:00:00.000Z"),
      depth: 10,
      settings: {
        palette: "rdylbu",
        opacity: 0.8,
        speedFactor: [0.01, 0.07],
      },
    });

    expect(snippet).toContain("function handler()");
    expect(snippet).toContain("moduleLoad");
    expect(snippet).toContain("\"arco_time_map_legend\"");
    expect(snippet).toContain("const elLegend = getViewLegend(widget.opt.view, { clone: false })");
    expect(snippet).toContain("new ArcoMapLegend({");
    expect(snippet).toContain("elInputs: widget.elContent");
    expect(snippet).toContain("backend: \"zarr\"");
    expect(snippet).toContain("layer: \"surface-wind\"");
    expect(snippet).toContain("settings: {");
    expect(snippet).toContain("\"opacity\": 0.8");
    expect(snippet).toContain("time: new Date(\"2026-06-04T00:00:00.000Z\")");
    expect(snippet).toContain("depth: 10");
    expect(snippet).toContain("widget?._arco?.destroy()");
  });

  it("does not use the direct zartigl API in MapX widget code", () => {
    const snippet = buildMapxWidgetSnippet({ layerId: "scalar" });

    expect(snippet).not.toContain("new Zartigl({");
    expect(snippet).not.toContain("cc._zartigl");
  });
});

describe("buildStandaloneDemoSnippet", () => {
  it("builds a standalone zartigl script for external demos", () => {
    const snippet = buildStandaloneDemoSnippet({
      layerId: "surface-wind",
      backend: "wmts",
      time: new Date("2026-06-04T00:00:00.000Z"),
      depth: 10,
      settings: { opacity: 0.8 },
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
    expect(snippet).toContain("backend: \"wmts\"");
    expect(snippet).toContain("await z.setLayer(\"surface-wind\")");
    expect(snippet).toContain("z.updateSettings({");
    expect(snippet).toContain("z.setTimeAndDepth(new Date(\"2026-06-04T00:00:00.000Z\"), 10)");
  });
});
