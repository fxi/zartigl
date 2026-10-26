import { describe, expect, it } from "vitest";
import { formatUnit } from "./units";

describe("formatUnit", () => {
  it.each([
    // Every raw `units` attribute of the built-in catalog.
    ["m s-1", "m/s"],
    ["m/s", "m/s"],
    ["mg m-3", "mg/m³"],
    ["milligram m^-3", "mg/m³"],
    ["mol m-3", "mol/m³"],
    ["mmol m-3", "mmol/m³"],
    ["mg m-3 day-1", "mg/m³/d"],
    ["g m^-2 d^-1", "g/m²/d"],
    ["kg m-2 s-1", "kg/m²/s"],
    ["W m-2", "W/m²"],
    ["N m-2", "N/m²"],
    ["Pa", "Pa"],
    ["m", "m"],
    ["s", "s"],
    ["degree", "°"],
    ["1", ""],
    ["1e-3", "PSU"],
    ["0.001", "PSU"],
    ["kelvin", "K"],
    ["degrees_C", "°C"],
    ["degrees_Celsius", "°C"],
    ["degree_Celsius_weeks", "°C-weeks"],
    ["stress_level", ""],
  ])("%s → %s", (raw, label) => {
    expect(formatUnit(raw)).toBe(label);
  });

  it("handles missing, positive powers, bare denominators and unknowns", () => {
    expect(formatUnit(undefined)).toBe("");
    expect(formatUnit("  ")).toBe("");
    expect(formatUnit("m2 s-1")).toBe("m²/s");
    expect(formatUnit("s-1")).toBe("1/s");
    expect(formatUnit("sea_water_units")).toBe("sea water units");
  });
});
