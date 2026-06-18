export interface TimeDimension {
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
  size: number;
  chunkSize?: number;
  units?: string;
}

export interface SpatialDimension {
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
  size?: number;
  chunkSize?: number;
  units?: string;
}

export interface VerticalDimension {
  label: "depth" | "pressure" | string;
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
  size?: number;
  chunkSize?: number;
  units?: string;
}

export interface CatalogWmts {
  capabilities_url: string;
  base_url: string;
  layer: string;
  tileMatrixSet: string;
  format: string;
  style?: string;
}

export interface CatalogVectorDerivation {
  kind: "direction_magnitude";
  direction_variable: string;
  magnitude_variable: string;
  direction_convention: "from" | "toward";
  output_direction: "from" | "toward";
}

export type CatalogVariables =
  | {
      kind: "scalar";
      value: string;
      standardName?: string;
      units?: string;
    }
  | {
      kind: "vector";
      u?: string;
      v?: string;
      derivation?: CatalogVectorDerivation;
      standardName?: string;
      units?: string;
    };

interface CatalogLayerBase {
  id: string;
  label: string;
  description?: string;
  category?: string;
  tags?: string[];
  dataset: {
    id: string;
    provider?: "copernicus" | string;
    productId?: string;
  };
  stores: {
    field: {
      type: "zarr";
      url: string;
      layout: "time-chunked";
    };
    pointSeries?: {
      type: "zarr";
      url: string;
      layout: "geo-chunked";
    };
    wmts?: CatalogWmts;
  };
  dimensions: {
    time: TimeDimension;
    vertical?: VerticalDimension;
    latitude?: SpatialDimension;
    longitude?: SpatialDimension;
  };
  defaults?: {
    backend?: "zarr" | "wmts";
    palette?: string;
    particles?: {
      density?: number;
      speed?: number;
      fade?: number;
    };
    raster?: {
      opacity?: number;
      logScale?: boolean;
      vibrance?: number;
    };
  };
}

export type CatalogLayer =
  | (CatalogLayerBase & {
      kind: "scalar";
      variables: Extract<CatalogVariables, { kind: "scalar" }>;
    })
  | (CatalogLayerBase & {
      kind: "vector";
      variables: Extract<CatalogVariables, { kind: "vector" }>;
    });

export interface Catalog {
  schemaVersion: 1;
  generatedAt: string;
  layers: CatalogLayer[];
}
