import { describe, expect, it } from "vitest";
import { resolveEntryStyle } from "../catalog";
import { hashStyle, patchedStyle, styleParams } from "./style-state";

describe("hashStyle", () => {
  it("reads the style override of a share link", () => {
    const st = { palette: "thermal", particles: { grade: "vibrant" as const } };
    expect(hashStyle({ st, p: "ignored" }, "vector")).toEqual(st);
  });

  it("reads the first format's flat keys", () => {
    expect(
      hashStyle(
        {
          p: "thermal",
          pd: 0.03,
          sp: 2,
          rm: "raster+particles",
          op: 0.8,
          ls: false,
          vb: 0,
          cd: null,
        },
        "vector",
      ),
    ).toEqual({
      palette: "thermal",
      renderMode: "raster+particles",
      particles: { density: 0.03, speed: 2 },
      raster: { opacity: 0.8, logScale: false, vibrance: 0, colorDomain: null },
    });
  });

  it("drops what a scalar layer cannot draw", () => {
    expect(
      hashStyle({ p: "thermal", pd: 0.03, rm: "particles" }, "scalar"),
    ).toEqual({ palette: "thermal" });
  });
});

describe("styleParams", () => {
  it("shows a resolved style, a tuned grade as vibrant", () => {
    const params = styleParams(
      resolveEntryStyle(
        { kind: "scalar", defaults: { raster: { colorDomain: [-3, 3] } } },
        { particles: { grade: { contrast: 0.2 } } },
      ),
    );
    expect(params).toMatchObject({
      palette: "rdylbu",
      renderMode: "raster",
      vibrant: true,
      colorDomain: [-3, 3],
      colorDomainMin: -3,
      colorDomainMax: 3,
    });
  });
});

describe("patchedStyle", () => {
  const scalar = { kind: "scalar" as const, defaults: { palette: "thermal" } };

  it("ignores a pane refresh echoing what the layer draws", () => {
    // Particle controls are hidden on a scalar layer.
    expect(patchedStyle({}, { particles: { density: 0.05 } }, scalar)).toBe(
      undefined,
    );
    expect(patchedStyle({}, { palette: "thermal" }, scalar)).toBe(undefined);
  });

  it("patches what a control changes", () => {
    expect(
      patchedStyle({ palette: "ice" }, { raster: { opacity: 0.5 } }, scalar),
    ).toEqual({ palette: "ice", raster: { opacity: 0.5 } });
  });
});
