import { describe, expect, it } from "vitest";
import { parseWmtsCapabilities } from "./WmtsCapabilities";
import type { CatalogWmtsSource } from "../catalog/types";

const source: CatalogWmtsSource = { id: "source", type: "wmts", title: { en: "WMTS" }, capabilitiesUrl: "https://example.test/capabilities", layer: "ocean/temperature" };
const xml = `<Capabilities><OperationsMetadata><Operation name="GetTile"><Get xlink:href="https://tiles.test/wmts"/></Operation></OperationsMetadata><Contents><Layer>
  <Identifier>ocean/temperature</Identifier><Format>image/png</Format><Style isDefault="true"><Identifier>default</Identifier></Style>
  <ResourceURL format="image/png" resourceType="tile" template="https://tiles.test/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}?style={Style}&amp;time={Time}&amp;elevation={elevation}"/>
  <TileMatrixSetLink><TileMatrixSet>EPSG:3857</TileMatrixSet></TileMatrixSetLink>
  <Dimension><Identifier>time</Identifier><Value>2026-01-01T00:00:00Z/2026-01-03T00:00:00Z/P1D</Value></Dimension>
  <Dimension><Identifier>elevation</Identifier><Value>0,10,20</Value></Dimension>
</Layer></Contents></Capabilities>`;

describe("WMTS capabilities", () => {
  it("normalizes temporal and vertical dimensions", () => {
    const metadata = parseWmtsCapabilities(xml, source);
    expect(metadata.baseUrl).toBe("https://tiles.test/wmts");
    expect(metadata.tileUrlTemplate).toBe("https://tiles.test/EPSG:3857/{z}/{y}/{x}?style=default&time={Time}&elevation={elevation}");
    expect(metadata.style).toBe("default");
    expect(metadata.time.values).toHaveLength(3);
    expect(metadata.time.step).toBe(86_400_000);
    expect(metadata.vertical?.values).toEqual([0, 10, 20]);
  });

  it("expands calendar-month intervals without treating months as fixed days", () => {
    const monthly = xml.replace("2026-01-01T00:00:00Z/2026-01-03T00:00:00Z/P1D", "2026-01-01T00:00:00Z/2026-04-01T00:00:00Z/P1M");
    expect(parseWmtsCapabilities(monthly, source).time.values.map((value) => new Date(value).getUTCMonth())).toEqual([0, 1, 2, 3]);
  });

  it("rejects unknown layers and unsupported projections", () => {
    expect(() => parseWmtsCapabilities(xml, { ...source, layer: "missing" })).toThrow(/do not contain layer/);
    expect(() => parseWmtsCapabilities(xml.replace("EPSG:3857", "EPSG:3413"), source)).toThrow(/Unsupported/);
  });

  it("falls back from REST templates with unresolved placeholders", () => {
    const unresolved = xml.replace("{TileMatrixSet}", "{UnsupportedDimension}");
    expect(parseWmtsCapabilities(unresolved, source).tileUrlTemplate).toBeUndefined();
  });

  it("clamps month arithmetic to the target month and preserves leap years", () => {
    const january = xml.replace("2026-01-01T00:00:00Z/2026-01-03T00:00:00Z/P1D", "2026-01-31T12:34:56Z/2026-03-31T12:34:56Z/P1M");
    expect(parseWmtsCapabilities(january, source).time.values.map((value) => new Date(value).toISOString())).toEqual([
      "2026-01-31T12:34:56.000Z", "2026-02-28T12:34:56.000Z", "2026-03-28T12:34:56.000Z",
    ]);
    const leap = xml.replace("2026-01-01T00:00:00Z/2026-01-03T00:00:00Z/P1D", "2020-02-29T00:00:00Z/2021-02-28T00:00:00Z/P1Y");
    expect(parseWmtsCapabilities(leap, source).time.values.map((value) => new Date(value).toISOString())).toEqual([
      "2020-02-29T00:00:00.000Z", "2021-02-28T00:00:00.000Z",
    ]);
  });
});
