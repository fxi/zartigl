export type LocalizedText = Record<string, string>;

export interface CatalogSourceProvenance {
  provider: string;
  identifiers?: Record<string, string>;
}

export interface CatalogTemporalSummary {
  cadence?: string;
  mode: "historical" | "near-real-time" | "analysis-forecast" | "fixed";
  start?: string;
  end?: string;
}

export interface CatalogVectorDerivation {
  kind: "direction_magnitude";
  direction_variable: string;
  magnitude_variable: string;
  direction_convention: "from" | "toward";
  output_direction: "from" | "toward";
}

export type CatalogVariables =
  | { kind: "scalar"; value: string }
  | { kind: "vector"; u?: string; v?: string; derivation?: CatalogVectorDerivation };

interface CatalogSourceBase {
  id: string;
  title: LocalizedText;
  provenance?: CatalogSourceProvenance;
  temporal?: CatalogTemporalSummary;
}

export interface CatalogZarrSource extends CatalogSourceBase {
  type: "zarr";
  endpoints: { field: string; pointSeries?: string };
  variables: CatalogVariables;
}

export interface CatalogWmtsSource extends CatalogSourceBase {
  type: "wmts";
  capabilitiesUrl: string;
  baseUrl?: string;
  layer: string;
  tileMatrixSet?: string;
  format?: string;
  style?: string;
  tileUrlTemplate?: string;
}

export interface CatalogGeoVideoSource extends CatalogSourceBase {
  type: "geovideo";
  manifestUrl: string;
}

export type CatalogSource = CatalogZarrSource | CatalogWmtsSource | CatalogGeoVideoSource;
export type CatalogSourceType = CatalogSource["type"];
export type CatalogSourcePreference = "auto" | CatalogSourceType | string;

export interface CatalogEntry {
  id: string;
  aliases?: string[];
  title: LocalizedText;
  description?: LocalizedText;
  category: string;
  tags?: string[];
  kind: "scalar" | "vector";
  sources: CatalogSource[];
  defaults: {
    sourceId: string;
    querySourceId?: string;
    palette?: string;
    renderMode?: "particles" | "raster" | "raster+particles";
    particles?: { density?: number; speed?: number; fade?: number };
    raster?: {
      opacity?: number;
      logScale?: boolean;
      vibrance?: number;
      colorDomain?: [number, number];
    };
  };
}

export interface Catalog {
  schemaVersion: 2;
  defaultLocale: string;
  layers: CatalogEntry[];
}

export interface CatalogSearchOptions {
  locale?: string;
  category?: string;
  sourceType?: CatalogSourceType;
  provider?: string;
}

export interface CatalogEntrySelector extends CatalogSearchOptions {
  identifiers?: Record<string, string>;
  variableId?: string;
}
