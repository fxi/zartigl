export interface RegionBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface RegionStatsPoint {
  time: string;
  mean: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export interface EnsoRegionSeries {
  id: string;
  label: string;
  bounds: RegionBounds;
  points: RegionStatsPoint[];
}

export interface EnsoStoryData {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    layerId: string;
    datasetId: string;
    storeUrl: string;
    variable: string;
    unit: string;
    method: string;
    timeStart: string;
    timeEnd: string;
  };
  regions: EnsoRegionSeries[];
}

export interface BalticHypoxiaPoint {
  time: string;
  hypoxicAreaKm2: number;
  validAreaKm2: number;
  hypoxicFractionPct: number;
  trailingFiveYearMeanKm2: number | null;
}

export interface BalticHypoxiaStoryData {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    layerId: string;
    datasetId: string;
    productId: string;
    storeUrl: string;
    variable: string;
    unit: string;
    timeStart: string;
    timeEnd: string;
  };
  analysis: {
    label: string;
    sampling: string;
    thresholdMmolM3: number;
    thresholdMgL: number;
    comparison: string;
    areaMethod: string;
    rollingMean: string;
    limitations: string[];
  };
  references: Array<{ label: string; url: string }>;
  points: BalticHypoxiaPoint[];
}
