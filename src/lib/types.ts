import type { ZarrSource } from "./ZarrSource";

export interface DirectionMagnitudeVectorDerivation {
  kind: "direction_magnitude";
  direction_variable: string;
  magnitude_variable: string;
  direction_convention: "from" | "toward";
  output_direction: "from" | "toward";
}

export type VectorDerivation = DirectionMagnitudeVectorDerivation;

export interface VectorLayerOptions {
  id: string;
  source: string;
  /** Optional initialized/shared source. When omitted, the layer creates one from `source`. */
  zarrSource?: ZarrSource;
  variableU?: string;
  variableV?: string;
  vectorDerivation?: VectorDerivation;
  /** Particles per screen pixel. Count = clamp(w × h × density, 1, 262144). Default 0.05. */
  particleDensity?: number;
  /** Max pixels/frame for the fastest current. Constant visual speed at any zoom. Default 1.0. */
  speed?: number;
  /** Trail length [0, 1] (higher = longer trails). Default 0.7. */
  fade?: number;
  colorRamp?: Record<number, string>;
  time?: string | number;
  depth?: number;
  /** Global layer opacity [0, 1]. Default 1.0. */
  opacity?: number;
  /** Logarithmic speed normalization. Default false. */
  logScale?: boolean;
  /** Vibrance adjustment [-1, 1]. Default 0.0. */
  vibrance?: number;
  unit?: string;
}

export type ArcoLayerCatalogLayer = CatalogLayer;

export type ArcoLayerBackendPreference = "auto" | "wmts" | "zarr";
export type ArcoLayerBackend = "vector" | "scalar-zarr" | "scalar-wmts";

export interface ArcoLayerOptions
  extends Omit<VectorLayerOptions, "source" | "variableU" | "variableV"> {
  layer: ArcoLayerCatalogLayer;
  backend?: ArcoLayerBackendPreference;
  verticalLabel?: string;
  metadata?: Record<string, unknown>;
  before?: string;
}

export interface ScalarLayerOptions {
  id: string;
  source: string;
  /** Optional initialized/shared source. When omitted, the layer creates one from `source`. */
  zarrSource?: ZarrSource;
  variable: string;
  colorRamp?: Record<number, string>;
  time?: string | number;
  depth?: number;
  opacity?: number;
  logScale?: boolean;
  vibrance?: number;
  unit?: string;
}

export interface ZarrArrayMeta {
  zarr_format: number;
  shape: number[];
  chunks: number[];
  dtype: string;
  compressor: {
    id: string;
    level?: number;
    clevel?: number;
    cname?: string;
    shuffle?: number;
    blocksize?: number;
  } | null;
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
  positive?: "up" | "down" | string;
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
  /** True when latitude rows are stored north-to-south (needs GL Y-flip). */
  latDescending?: boolean;
  /** When true: R=scalar_norm, G=128(neutral), V loop skipped. */
  scalarMode?: boolean;
}

export interface FieldMeta {
  min: number;
  max: number;
  unit: string;
  time: string;
  depth?: number;
}

export interface ZarrPointSample {
  axisValue: number;
  time?: number;
  depth?: number;
  values: Record<string, number>;
}

export interface ZarrPointSeriesResult {
  longitude: number;
  latitude: number;
  depth?: number;
  time?: number;
  points: ZarrPointSample[];
}

export interface ZarrTimeDimension {
  min: number;
  max: number;
  step?: number;
  size: number;
  units: string;
  values: number[];
}

export interface ZarrVerticalDimension {
  name: string;
  label: "depth" | "pressure" | string;
  units?: string;
  values: number[];
}
import type { CatalogLayer } from "../catalog/types";
