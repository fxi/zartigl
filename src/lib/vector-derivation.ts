import type { VectorDerivation } from "./types";

export function deriveDirectionMagnitudeComponents(
  directionDegrees: number,
  magnitude: number,
  derivation: VectorDerivation,
): { u: number; v: number } {
  if (!Number.isFinite(directionDegrees) || !Number.isFinite(magnitude)) {
    return { u: NaN, v: NaN };
  }

  const flip =
    derivation.direction_convention !== derivation.output_direction ? 180 : 0;
  const radians = ((directionDegrees + flip) * Math.PI) / 180;

  return {
    u: magnitude * Math.sin(radians),
    v: magnitude * Math.cos(radians),
  };
}

export function getVectorDerivationVariables(
  derivation: VectorDerivation,
): [string, string] {
  return [derivation.direction_variable, derivation.magnitude_variable];
}
