/**
 * Short display label of a CF / UDUNITS `units` attribute, for legends and
 * query values: "mmol m-3" → "mmol/m³", "degree_Celsius_weeks" → "°C-weeks".
 * Unknown labels pass through with underscores turned into spaces.
 */

// Whole labels with a conventional symbol, or no unit worth showing.
const ALIASES: Record<string, string> = {
  degrees_c: "°C",
  degc: "°C",
  degrees_celsius: "°C",
  degree_celsius: "°C",
  celsius: "°C",
  // Degree heating weeks accumulate °C over weeks: a product, not a rate.
  degree_celsius_weeks: "°C-weeks",
  degree: "°",
  degrees: "°",
  kelvin: "K",
  "1": "",
  "1e-3": "PSU",
  "0.001": "PSU",
  psu: "PSU",
  stress_level: "",
};

const SYMBOLS: Record<string, string> = {
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  second: "s",
  seconds: "s",
  day: "d",
  days: "d",
  hour: "h",
  hours: "h",
  gram: "g",
  grams: "g",
  milligram: "mg",
  milligrams: "mg",
  kilogram: "kg",
  kilograms: "kg",
  mole: "mol",
  millimole: "mmol",
  watt: "W",
  newton: "N",
  pascal: "Pa",
  kelvin: "K",
};

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function superscript(power: number): string {
  return power === 1
    ? ""
    : [...String(power)].map((d) => SUPERSCRIPT[Number(d)]).join("");
}

export function formatUnit(unit: string | undefined): string {
  const raw = unit?.trim() ?? "";
  const alias = ALIASES[raw.toLowerCase()];
  if (alias != null) {
    return alias;
  }
  if (raw.includes("/")) {
    return raw;
  }
  const numerator: string[] = [];
  const denominator: string[] = [];
  for (const token of raw.split(/\s+/)) {
    const match = /^([A-Za-z]+)\^?(-?\d+)?$/.exec(token);
    if (!match) {
      return raw.replace(/_/g, " ");
    }
    const symbol = SYMBOLS[match[1]] ?? match[1];
    const power = Number(match[2] ?? 1);
    if (power < 0) {
      denominator.push(symbol + superscript(-power));
    } else {
      numerator.push(symbol + superscript(power));
    }
  }
  return [numerator.join(" ") || "1", ...denominator].join("/");
}
