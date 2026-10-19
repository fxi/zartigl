import { describe, expect, it } from "vitest";
import { COLOR_GRADE_OFF, COLOR_GRADE_VIBRANT } from "../engine";
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
    palette: "viridis",
    tint: "",
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
    expect(encodeShare(state)).toContain("s=0.5&c=viridis");
  });

  it("drops invalid fields", () => {
    expect(decodeShare("t=nope&r=1,2&z=-1&play=yes&p=globe&l=abc")).toEqual({
      preset: "globe",
      layer: "abc",
    });
    expect(decodeShare("r=1,x,3&z=0&s=0&c=")).toEqual({});
    expect(decodeShare("s=fast")).toEqual({});
  });

  it("keeps an explicit speed tint apart from no tint", () => {
    expect(decodeShare("k=")).toEqual({ tint: "" });
    expect(decodeShare("k=3db0120b")).toEqual({ tint: "3db0120b" });
  });

  it("shares the color grade only when enabled", () => {
    const grade = { ...COLOR_GRADE_VIBRANT, exposure: 1.23456 };
    const hash = encodeShare({ ...state, grade });
    expect(hash).toContain("g=1.235%2C0.6%2C0.4%2C0.6");
    expect(decodeShare(hash).grade).toEqual({ ...grade, exposure: 1.235 });
    expect(encodeShare({ ...state, grade: COLOR_GRADE_OFF })).not.toContain(
      "g=",
    );
  });

  it("clamps a shared grade and drops a malformed one", () => {
    expect(decodeShare("g=9,0.5,0,0").grade?.exposure).toBe(4);
    expect(decodeShare("g=1,2,x,4")).toEqual({});
    expect(decodeShare("g=1,2")).toEqual({});
  });

  it("decodes an empty hash to nothing", () => {
    expect(decodeShare("")).toEqual({});
    expect(decodeShare("#")).toEqual({});
  });
});
