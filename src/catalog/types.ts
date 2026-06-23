export interface CatalogWmts {
  capabilities_url: string;
  base_url: string;
  layer: string;
  tileMatrixSet: string;
  format: string;
  style?: string;
}

export type CatalogParticleColorMode = "palette" | "black" | "white" | "contrast";

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
    }
  | {
      kind: "vector";
      u?: string;
      v?: string;
      derivation?: CatalogVectorDerivation;
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
      url: string;
    };
    pointSeries?: {
      url: string;
    };
    wmts?: CatalogWmts;
  };
  defaults?: {
    backend?: "zarr" | "wmts";
    palette?: string;
    renderMode?: "particles" | "raster" | "raster+particles";
    particles?: {
      density?: number;
      speed?: number;
      fade?: number;
      colorMode?: CatalogParticleColorMode;
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
  layers: CatalogLayer[];
}
