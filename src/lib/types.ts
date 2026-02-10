export interface ParticleLayerOptions {
  id: string;
  source: string;
  variableU?: string;
  variableV?: string;
  particleCount?: number;
  speedFactor?: number;
  fadeOpacity?: number;
  dropRate?: number;
  dropRateBump?: number;
  colorRamp?: Record<number, string>;
  time?: string | number;
  depth?: number;
}

export interface ZarrArrayMeta {
  zarr_format: number;
  shape: number[];
  chunks: number[];
  dtype: string;
  compressor: { id: string; level?: number } | null;
  fill_value: number | string | null;
  order: string;
  filters: unknown[] | null;
  dimension_separator?: string;
}

export interface ZarrAttrs {
  _ARRAY_DIMENSIONS?: string[];
  units?: string;
  standard_name?: string;
  long_name?: string;
  calendar?: string;
  [key: string]: unknown;
}

export interface ZarrConsolidatedMeta {
  zarr_consolidated_format: number;
  metadata: Record<string, ZarrArrayMeta | ZarrAttrs | { zarr_format: number }>;
}

export interface ChunkKey {
  variable: string;
  timeIdx: number;
  depthIdx: number;
  latIdx: number;
  lonIdx: number;
}

export interface DecodedChunk {
  data: Float32Array;
  shape: [number, number];
  latRange: [number, number];
  lonRange: [number, number];
}

export interface VelocityData {
  u: Float32Array;
  v: Float32Array;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  bounds: { west: number; south: number; east: number; north: number };
}
