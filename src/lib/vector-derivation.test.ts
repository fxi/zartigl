import { describe, expect, it } from "vitest";
import { deriveDirectionMagnitudeComponents } from "./vector-derivation";
import type { VectorDerivation } from "./types";

const fromToToward: VectorDerivation = {
  kind: "direction_magnitude",
  direction_variable: "direction",
  magnitude_variable: "height",
  direction_convention: "from",
  output_direction: "toward",
};

describe("deriveDirectionMagnitudeComponents", () => {
  it("converts a from-direction into propagation-toward components", () => {
    expect(deriveDirectionMagnitudeComponents(0, 2, fromToToward)).toEqual({
      u: expect.closeTo(0, 6),
      v: expect.closeTo(-2, 6),
    });

    expect(deriveDirectionMagnitudeComponents(90, 3, fromToToward)).toEqual({
      u: expect.closeTo(-3, 6),
      v: expect.closeTo(0, 6),
    });
  });

  it("returns NaN components for missing source values", () => {
    const result = deriveDirectionMagnitudeComponents(NaN, 2, fromToToward);
    expect(result.u).toBeNaN();
    expect(result.v).toBeNaN();
  });
});
