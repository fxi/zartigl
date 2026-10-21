import { describe, expect, it } from "vitest";
import { BACKDROP_OFF, backdropVec4, resolveBackdrop } from "./backdrop";

describe("backdrop", () => {
  it("is off without input", () => {
    expect(resolveBackdrop()).toEqual(BACKDROP_OFF);
    expect(BACKDROP_OFF.enabled).toBe(false);
  });

  it("is on for any input, unless disabled", () => {
    expect(resolveBackdrop({}).enabled).toBe(true);
    expect(resolveBackdrop({ opacity: 0.2 })).toEqual({
      enabled: true,
      color: "#000000",
      opacity: 0.2,
    });
    expect(resolveBackdrop({ enabled: false }).enabled).toBe(false);
  });

  it("keeps defaults for invalid values and clamps opacity", () => {
    expect(
      resolveBackdrop({ enabled: true, color: "red", opacity: 3 }),
    ).toEqual({ enabled: true, color: "#000000", opacity: 1 });
    expect(resolveBackdrop({ opacity: Number.NaN }).opacity).toBe(0.5);
  });

  it("is a straight RGB color with zero alpha when off", () => {
    expect(
      backdropVec4({ enabled: true, color: "#ff8000", opacity: 0.25 }),
    ).toEqual([1, 128 / 255, 0, 0.25]);
    expect(
      backdropVec4({ enabled: true, color: "#f80", opacity: 0.25 }),
    ).toEqual([1, 136 / 255, 0, 0.25]);
    expect(backdropVec4({ ...BACKDROP_OFF, opacity: 1 })[3]).toBe(0);
  });
});
