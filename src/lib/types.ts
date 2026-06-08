/**
 * A param that is either a fixed scalar or a zoom-weighted range.
 * When a range [min, max] is given:
 *   - min is the value at high zoom (local / detail view)
 *   - max is the value at low zoom  (global / overview)
 * The layer interpolates between them based on the current map zoom
 * and the configured zoomRange.
 */
export type ZoomWeighted = number | [min: number, max: number];

export interface VectorLayerOptions {
  id: string;
  source: string;
  variableU?: string;
  variableV?: string;
  /** Particles per screen pixel. Count = clamp(w × h × density, 1, 262144). Default 0.05. */
  particleDensity?: number;
  /** Fixed speed or [atHighZoom, atLowZoom]. */
  speedFactor?: ZoomWeighted;
  /** Fixed fade or [atHighZoom, atLowZoom]. */
  fadeOpacity?: ZoomWeighted;
  dropRate?: number;
  dropRateBump?: number;
  colorRamp?: Record<number, string>;
  time?: string | number;
  depth?: number;
  /** [lowZoom, highZoom] breakpoints for zoom-weighted params. Default [2, 12]. */
  zoomRange?: [number, number];
  /** Global layer opacity [0, 1]. Default 1.0. */
  opacity?: number;
  /** Logarithmic speed normalization. Default false. */
  logScale?: boolean;
  /** Vibrance adjustment [-1, 1]. Default 0.0. */
  vibrance?: number;
}

export interface ArcoLayerView {
  type: "vector" | "scalar";
  zarr_url_geo: string;
  variable?: string;
  variable_u?: string;
  variable_v?: string;
  variable_meta?: { standard_name: string; units: string };
  vertical_label?: string;
  wmts?: {
    capabilities_url: string;
    base_url: string;
    layer: string;
    tileMatrixSet: string;
    format: string;
    style?: string;
  };
}

export type ArcoLayerBackendPreference = "auto" | "wmts" | "zarr";
export type ArcoLayerBackend = "vector" | "scalar-zarr" | "scalar-wmts";

export interface ArcoLayerOptions
  extends Omit<VectorLayerOptions, "source" | "variableU" | "variableV"> {
  view: ArcoLayerView;
  backend?: ArcoLayerBackendPreference;
}

export interface ScalarLayerOptions {
  id: string;
  source: string;
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
}
