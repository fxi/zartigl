import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare, type ShareState } from "./share";

describe("share hash", () => {
  const state: ShareState = {
    layer: "72aa3549-8cdf-4275-b8f7-5b32ca40a3f2",
    time: Date.UTC(2025, 2, 14, 7),
    preset: "globe",
    rotate: [-20.12345, 25.5, 0],
    zoom: 1.23456,
    playing: false,
    speed: 0.5,
    tint: "",
    style: { palette: "viridis", particles: { grade: { contrast: 0.2 } } },
  };

  it("round-trips the view, rounded", () => {
    expect(decodeShare(`#${encodeShare(state)}`)).toEqual({
      ...state,
      rotate: [-20.123, 25.5, 0],
      zoom: 1.235,
    });
  });

  it("stays readable", () => {
    expect(encodeShare(state)).toContain("t=2025-03-14T07%3A00%3A00.000Z");
    expect(encodeShare(state)).toContain("play=0");
    expect(encodeShare({ ...state, style: {} })).not.toContain("st=");
  });

  it("drops invalid fields", () => {
    expect(decodeShare("t=nope&r=1,2&z=-1&play=yes&p=globe&l=abc")).toEqual({
      preset: "globe",
      layer: "abc",
    });
    expect(decodeShare("r=1,x,3&z=0&s=0&c=")).toEqual({});
    expect(decodeShare("s=fast")).toEqual({});
    expect(decodeShare("st=nope")).toEqual({});
    expect(
      decodeShare(`st=${encodeURIComponent('{"particles":{"density":9}}')}`),
    ).toEqual({});
  });

  it("keeps an explicit speed tint apart from no tint", () => {
    expect(decodeShare("k=")).toEqual({ tint: "" });
    expect(decodeShare("k=3db0120b")).toEqual({ tint: "3db0120b" });
  });

  it("reads the first format's palette and grade into the style", () => {
    expect(decodeShare("c=viridis&g=1.235,0.6,0.4,0.6")).toEqual({
      style: {
        palette: "viridis",
        particles: {
          grade: {
            exposure: 1.235,
            contrast: 0.6,
            saturation: 0.4,
            highlights: 0.6,
          },
        },
      },
    });
    expect(decodeShare("g=0.8,0.6,0.4,0.6")).toEqual({
      style: { particles: { grade: "vibrant" } },
    });
    // A style written next to them wins.
    const st = encodeURIComponent('{"palette":"ice"}');
    expect(decodeShare(`c=viridis&st=${st}`).style).toEqual({
      palette: "ice",
    });
  });

  it("clamps a legacy grade and drops a malformed one", () => {
    expect(decodeShare("g=9,0.5,0,0").style?.particles?.grade).toMatchObject({
      exposure: 4,
    });
    expect(decodeShare("g=1,2,x,4")).toEqual({});
    expect(decodeShare("g=1,2")).toEqual({});
  });

  it("decodes an empty hash to nothing", () => {
    expect(decodeShare("")).toEqual({});
    expect(decodeShare("#")).toEqual({});
  });
});
