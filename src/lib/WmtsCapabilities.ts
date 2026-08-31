import type { CatalogWmtsSource } from "../catalog/types";
import type { ZarrTimeDimension, ZarrVerticalDimension } from "./types";

export interface WmtsMetadata {
  baseUrl: string;
  tileUrlTemplate?: string;
  tileMatrixSet: string;
  format: string;
  style?: string;
  time: ZarrTimeDimension;
  vertical: ZarrVerticalDimension | null;
}

function xmlAttribute(value: string, name: string): string | undefined {
  const match = value.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
  return match?.[1]
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeTileTemplate(value: string, tileMatrixSet: string, style?: string): string | undefined {
  const normalized = value
    .replace(/\{TileMatrix\}/gi, "{z}")
    .replace(/\{TileRow\}/gi, "{y}")
    .replace(/\{TileCol\}/gi, "{x}")
    .replace(/\{TileMatrixSet\}/gi, tileMatrixSet);
  const styled = style == null ? normalized : normalized.replace(/\{Style\}/gi, style);
  const unresolved = [...styled.matchAll(/\{([^{}]+)\}/g)].some((match) =>
    !/^(?:z|y|x|Time|Elevation)$/i.test(match[1]),
  );
  return unresolved ? undefined : styled;
}

function text(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

function blocks(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:(?:\\w+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${name}>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

function first(block: string, name: string): string | undefined {
  return blocks(block, name).map(text).find(Boolean);
}

function advanceDuration(time: number, value: string): number | undefined {
  const match = value.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match || !match.slice(1).some((part) => Number(part) > 0)) return undefined;
  const date = new Date(time);
  const year = date.getUTCFullYear() + Number(match[1] ?? 0);
  const month = date.getUTCMonth() + Number(match[2] ?? 0);
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const milliseconds = date.getUTCMilliseconds();
  const target = new Date(Date.UTC(year, month, 1, hours, minutes, seconds, milliseconds));
  const daysInTargetMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  target.setUTCDate(target.getUTCDate() + Number(match[3] ?? 0));
  target.setUTCHours(target.getUTCHours() + Number(match[4] ?? 0));
  target.setUTCMinutes(target.getUTCMinutes() + Number(match[5] ?? 0));
  target.setUTCSeconds(target.getUTCSeconds() + Number(match[6] ?? 0));
  return target.getTime();
}

function parseTimes(values: string[]): number[] {
  const result: number[] = [];
  for (const raw of values.flatMap((value) => value.split(","))) {
    const parts = raw.trim().split("/");
    if (parts.length === 3) {
      const start = Date.parse(parts[0]);
      const end = Date.parse(parts[1]);
      const next = advanceDuration(start, parts[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && next && next > start) {
        for (let time = start, count = 0; time <= end && count < 100_000; count += 1) {
          result.push(time);
          time = advanceDuration(time, parts[2])!;
        }
      }
      continue;
    }
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) result.push(parsed);
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

function dimension(layer: string, identifier: string): string[] {
  for (const block of blocks(layer, "Dimension")) {
    if (first(block, "Identifier")?.toLowerCase() === identifier.toLowerCase()) return blocks(block, "Value").map(text);
  }
  return [];
}

export function parseWmtsCapabilities(xml: string, source: CatalogWmtsSource): WmtsMetadata {
  const layer = blocks(xml, "Layer").find((candidate) => first(candidate, "Identifier") === source.layer);
  if (!layer) throw new Error(`WMTS capabilities do not contain layer: ${source.layer}`);
  const matrix = source.tileMatrixSet ?? first(layer, "TileMatrixSet") ?? "";
  if (!/3857|GoogleMapsCompatible/i.test(matrix)) {
    throw new Error(`Unsupported WMTS tile matrix set: ${matrix || "missing"}`);
  }
  const timeValues = parseTimes(dimension(layer, "time"));
  const time = timeValues.length ? {
    min: timeValues[0], max: timeValues[timeValues.length - 1], size: timeValues.length,
    values: timeValues, units: "milliseconds since 1970-01-01T00:00:00Z",
    step: timeValues.length > 1 && timeValues.every((value, index) => index === 0 || value - timeValues[index - 1] === timeValues[1] - timeValues[0])
      ? timeValues[1] - timeValues[0] : undefined,
  } : { min: 0, max: 0, size: 1, values: [0], units: "static" };
  const elevations = dimension(layer, "elevation").flatMap((value) => value.split(",")).map(Number).filter(Number.isFinite);
  const vertical = elevations.length ? { name: "elevation", label: "elevation", values: elevations } : null;
  const getHref = xml.match(/GetTile[\s\S]*?(?:xlink:href|href)=["']([^"']+)/i)?.[1];
  const resourceUrls = [...layer.matchAll(/<(?:(?:\w+):)?ResourceURL\b([^>]*)\/?\s*>/gi)];
  const tileResource = resourceUrls.find((match) => xmlAttribute(match[1], "resourceType")?.toLowerCase() === "tile");
  const resourceTemplate = tileResource ? xmlAttribute(tileResource[1], "template") : undefined;
  const styleElements = [...layer.matchAll(/<(?:(?:\w+):)?Style\b([^>]*)>([\s\S]*?)<\/(?:(?:\w+):)?Style>/gi)];
  const defaultStyle = styleElements.find((match) => xmlAttribute(match[1], "isDefault")?.toLowerCase() === "true");
  const style = source.style ?? first(defaultStyle?.[2] ?? styleElements[0]?.[2] ?? "", "Identifier");
  return {
    baseUrl: source.baseUrl ?? getHref ?? new URL(source.capabilitiesUrl).origin,
    tileUrlTemplate: source.tileUrlTemplate ?? (resourceTemplate ? normalizeTileTemplate(resourceTemplate, matrix, style) : undefined),
    tileMatrixSet: matrix,
    format: source.format ?? first(layer, "Format") ?? "image/png",
    style,
    time,
    vertical,
  };
}

export async function loadWmtsCapabilities(source: CatalogWmtsSource, signal?: AbortSignal): Promise<WmtsMetadata> {
  const response = await fetch(source.capabilitiesUrl, { signal });
  if (!response.ok) throw new Error(`WMTS capabilities request failed (${response.status}): ${source.capabilitiesUrl}`);
  return parseWmtsCapabilities(await response.text(), source);
}
