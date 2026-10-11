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
  });

  it("drops invalid fields", () => {
    expect(decodeShare("t=nope&r=1,2&z=-1&play=yes&p=globe&l=abc")).toEqual({
      preset: "globe",
      layer: "abc",
    });
    expect(decodeShare("r=1,x,3&z=0")).toEqual({});
  });

  it("decodes an empty hash to nothing", () => {
    expect(decodeShare("")).toEqual({});
    expect(decodeShare("#")).toEqual({});
  });
});
