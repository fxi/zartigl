import catalogJson from "./catalog.json";
import type {
  Catalog,
  CatalogEntry,
  CatalogEntrySelector,
  CatalogSearchOptions,
  CatalogSource,
  LocalizedText,
} from "./types";

export type {
  Catalog,
  CatalogEntry,
  CatalogEntrySelector,
  CatalogGeoVideoSource,
  CatalogSearchOptions,
  CatalogSource,
  CatalogSourcePreference,
  CatalogSourceProvenance,
  CatalogSourceType,
  CatalogTemporalSummary,
  CatalogVariables,
  CatalogVectorDerivation,
  CatalogWmtsSource,
  CatalogZarrSource,
  LocalizedText,
} from "./types";

export const catalog = catalogJson as Catalog;

export function resolveLocalizedText(
  value: LocalizedText | undefined,
  locale: string,
  defaultLocale = "en",
): string {
  if (!value) {
    return "";
  }
  const language = locale.toLowerCase().split("-")[0];
  return (
    value[locale] ??
    value[language] ??
    value[defaultLocale] ??
    Object.values(value)[0] ??
    ""
  );
}

export function getCatalogEntry(
  id: string,
  data: Catalog = catalog,
): CatalogEntry | undefined {
  return data.layers.find((entry) => entry.id === id);
}

export function requireCatalogEntry(
  id: string,
  data: Catalog = catalog,
): CatalogEntry {
  const entry = getCatalogEntry(id, data);
  if (!entry) {
    throw new Error(`Unknown zartigl catalog entry: ${id}`);
  }
  return entry;
}

const SCALAR_SOURCE_PRIORITY: CatalogSource["type"][] = [
  "geovideo",
  "wmts",
  "zarr",
];

const VECTOR_SOURCE_PRIORITY: CatalogSource["type"][] = ["geovideo", "zarr"];

/** Requested instant and/or window, in epoch milliseconds. */
export interface SourceTimeRequest {
  time?: number;
  start?: number;
  end?: number;
}

/**
 * Whether a source can show the requested time. Only fixed-period sources
 * (rendered artifacts such as GeoVideo) declare hard bounds; live sources are
 * assumed to cover any request and are bounded by their own metadata.
 */
export function sourceCoversTime(
  source: CatalogSource,
  request: SourceTimeRequest = {},
): boolean {
  const temporal = source.temporal;
  if (temporal?.mode !== "fixed") {
    return true;
  }
  const start = temporal.start ? Date.parse(temporal.start) : -Infinity;
  const end = temporal.end ? Date.parse(temporal.end) : Infinity;
  if (request.time != null && (request.time < start || request.time > end)) {
    return false;
  }
  return (
    (request.start ?? -Infinity) <= end && (request.end ?? Infinity) >= start
  );
}

/**
 * Preferred render source: GeoVideo, then WMTS (scalar), then Zarr, skipping
 * fixed-period sources that cannot show the requested time. Several GeoVideo
 * periods may coexist; the latest covering one wins. GeoVideo is a
 * lightweight display transport; Zarr stays the fallback and query source.
 */
export function pickPreferredSource(
  entry: CatalogEntry,
  request?: SourceTimeRequest,
): CatalogSource {
  const priority =
    entry.kind === "vector" ? VECTOR_SOURCE_PRIORITY : SCALAR_SOURCE_PRIORITY;
  const covering = entry.sources.filter((source) =>
    sourceCoversTime(source, request),
  );
  for (const candidates of [covering, entry.sources]) {
    for (const type of priority) {
      const matches = candidates.filter((source) => source.type === type);
      if (matches.length) {
        return latestPeriod(matches);
      }
    }
  }
  return entry.sources[0];
}

/** Among same-type sources, the one whose fixed period ends last; open-ended sources win. */
function latestPeriod(sources: CatalogSource[]): CatalogSource {
  const end = (source: CatalogSource) =>
    source.temporal?.mode === "fixed" && source.temporal.end
      ? Date.parse(source.temporal.end)
      : Infinity;
  return sources.reduce((best, source) =>
    end(source) > end(best) ? source : best,
  );
}

function sourceVariables(source: CatalogSource): string[] {
  if (source.type !== "zarr") {
    return [];
  }
  if (source.variables.kind === "scalar") {
    return [source.variables.value];
  }
  if (source.variables.derivation) {
    return [
      source.variables.derivation.direction_variable,
      source.variables.derivation.magnitude_variable,
    ];
  }
  return [source.variables.u, source.variables.v].filter(
    (value): value is string => !!value,
  );
}

export function findCatalogEntries(
  selector: CatalogEntrySelector,
  data: Catalog = catalog,
): CatalogEntry[] {
  return data.layers.filter((entry) => {
    if (selector.category && entry.category !== selector.category) {
      return false;
    }
    return entry.sources.some((source) => {
      if (selector.sourceType && source.type !== selector.sourceType) {
        return false;
      }
      if (
        selector.provider &&
        source.provenance?.provider !== selector.provider
      ) {
        return false;
      }
      if (
        selector.variableId &&
        !sourceVariables(source).includes(selector.variableId)
      ) {
        return false;
      }
      return (
        !selector.identifiers ||
        Object.entries(selector.identifiers).every(
          ([key, value]) => source.provenance?.identifiers?.[key] === value,
        )
      );
    });
  });
}

function searchableText(
  entry: CatalogEntry,
  locale: string,
  defaultLocale: string,
): string {
  const sourceText = entry.sources.flatMap((source) => [
    source.id,
    source.type,
    resolveLocalizedText(source.title, locale, defaultLocale),
    source.provenance?.provider,
    ...Object.entries(source.provenance?.identifiers ?? {}).flat(),
    source.temporal?.cadence,
    source.temporal?.mode,
    ...(source.type === "zarr" ? sourceVariables(source) : []),
    ...(source.type === "wmts" ? [source.layer] : []),
  ]);
  return [
    entry.id,
    resolveLocalizedText(entry.title, locale, defaultLocale),
    resolveLocalizedText(entry.description, locale, defaultLocale),
    entry.category,
    ...(entry.aliases ?? []),
    ...(entry.tags ?? []),
    ...sourceText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase(locale);
}

export function searchCatalog(
  query: string,
  options: CatalogSearchOptions = {},
  data: Catalog = catalog,
): CatalogEntry[] {
  const locale = options.locale ?? data.defaultLocale;
  const terms = query
    .trim()
    .toLocaleLowerCase(locale)
    .split(/\s+/)
    .filter(Boolean);
  return findCatalogEntries(options, data)
    .map((entry, index) => {
      const text = searchableText(entry, locale, data.defaultLocale);
      if (!terms.every((term) => text.includes(term))) {
        return null;
      }
      const title = resolveLocalizedText(
        entry.title,
        locale,
        data.defaultLocale,
      ).toLocaleLowerCase(locale);
      const aliases = (entry.aliases ?? []).map((alias) =>
        alias.toLocaleLowerCase(locale),
      );
      const score = terms.reduce(
        (total, term) =>
          total +
          (title === term
            ? 100
            : aliases.includes(term)
              ? 50
              : title.includes(term)
                ? 20
                : 1),
        0,
      );
      return { entry, score, index };
    })
    .filter(
      (item): item is { entry: CatalogEntry; score: number; index: number } =>
        !!item,
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ entry }) => entry);
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatVertical(
  v: number,
  label: string,
  units?: string,
): string {
  const unit = units?.trim();
  if (label === "pressure") {
    return `${Math.round(v)} ${unit || "hPa"}`;
  }
  if (unit && unit !== "m") {
    return `${Number(v.toPrecision(5))} ${unit}`;
  }
  if (v < 10) {
    return `${v.toFixed(2)} m`;
  }
  if (v < 100) {
    return `${v.toFixed(1)} m`;
  }
  return `${Math.round(v)} m`;
}
