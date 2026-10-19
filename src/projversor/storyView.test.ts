import { describe, expect, it } from "vitest";
import { COLOR_GRADE_OFF, COLOR_GRADE_VIBRANT } from "../engine";
import { parseProjversorView, projversorState } from "./storyView";

const view = (config: Record<string, unknown>) => ({
  id: "probe",
  type: "projversor",
  config: { layer: "surface-wind", preset: "globe", ...config },
});

describe("parseProjversorView", () => {
  it("rejects unknown layers, presets and palettes", () => {
    expect(() => parseProjversorView(view({ layer: "nope" }))).toThrow(/layer/);
    expect(() => parseProjversorView(view({ preset: "nope" }))).toThrow(
      /preset/,
    );
    expect(() => parseProjversorView(view({ palette: "nope" }))).toThrow(
      /palette/,
    );
  });

  it("rejects malformed numbers, dates and tints", () => {
    expect(() => parseProjversorView(view({ rotate: [0, 0] }))).toThrow(
      /rotate/,
    );
    expect(() => parseProjversorView(view({ zoom: 0 }))).toThrow(/zoom/);
    // A speed the renderer would silently ignore for this layer kind.
    expect(() => parseProjversorView(view({ speed: 3 }))).toThrow(/speed/);
    expect(() => parseProjversorView(view({ time: "soon" }))).toThrow(/time/);
    expect(() =>
      parseProjversorView(
        view({ layer: "sea-ice-thickness", preset: "north", tint: "" }),
      ),
    ).toThrow(/tint/);
  });

  it("maps a config to the projversor state", () => {
    const state = projversorState(
      parseProjversorView(
        view({ time: "2025-01-15T00:00:00Z", vibrant: true, tint: "" }),
      ),
    );
    expect(state).toMatchObject({
      layer: "surface-wind",
      preset: "globe",
      tint: "",
      time: Date.parse("2025-01-15T00:00:00Z"),
      grade: COLOR_GRADE_VIBRANT,
    });
    expect(projversorState(parseProjversorView(view({}))).grade).toBe(
      COLOR_GRADE_OFF,
    );
  });
});
