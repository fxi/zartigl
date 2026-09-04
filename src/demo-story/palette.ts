export const CHART_PALETTE = {
  ninoOne2: "#ff4df0",
  ninoThree: "#00ddff",
  ninoThreeFour: "#ffb000",
  ninoFour: "#39f58a",
} as const;

export const CHART_PALETTE_ORDER = Object.values(CHART_PALETTE);

export const ENSO_REGION_COLORS: Record<string, string> = {
  "nino-12": CHART_PALETTE.ninoOne2,
  "nino-3": CHART_PALETTE.ninoThree,
  "nino-34": CHART_PALETTE.ninoThreeFour,
  "nino-4": CHART_PALETTE.ninoFour,
};

export const SINGLE_SERIES_COLOR = CHART_PALETTE.ninoThree;

export const BALTIC_SERIES_COLORS = {
  annual: CHART_PALETTE.ninoThreeFour,
  trailing: CHART_PALETTE.ninoThree,
} as const;

export const MAP_LABEL_HALO_COLOR = "#111018";
