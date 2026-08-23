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
