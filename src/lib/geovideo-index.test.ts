import { describe, expect, it } from "vitest";
import type {
  CatalogEntry,
  CatalogGeoVideoArchiveSource,
} from "../catalog/types";
import {
  geoVideoChunkSources,
  isGeoVideoArchiveSource,
  isSameSource,
  validateGeoVideoIndex,
  type GeoVideoIndex,
} from "./geovideo-index";

const archive: CatalogGeoVideoArchiveSource = {
  id: "3f0e9a52-8c1d-4b7e-9f6a-2d4c8b1e7a90",
  type: "geovideo",
  title: { en: "Archive" },
  temporal: { mode: "historical", cadence: "P1M" },
  indexUrl: "https://example.test/geovideo/entry/source/index.json",
};
const entry = {
  id: "5e94f1b2-1342-4a1f-936e-09170d7d4db8",
  sources: [archive],
} as CatalogEntry;

function index(
  chunks: Partial<GeoVideoIndex["chunks"][number]>[] = [],
): GeoVideoIndex {
  return {
    schemaVersion: 1,
    type: "geovideo-index",
    catalogEntryId: entry.id,
    sourceId: archive.id,
    updatedAt: "2026-10-08T00:00:00Z",
    chunks: chunks.map((chunk) => ({
      period: { start: "2010-01-01T00:00:00Z", end: "2020-01-01T00:00:00Z" },
      start: "2010-01-16T12:00:00Z",
      end: "2019-12-16T12:00:00Z",
      samples: 120,
      key: "abc",
      manifestUrl: "abc/manifest.json",
      ...chunk,
    })),
  };
}

describe("GeoVideo archive index", () => {
  it("resolves chunks to fixed-period sources relative to the index", () => {
    const [chunk] = geoVideoChunkSources(archive, index([{}]), entry);
    expect(chunk).toEqual({
      id: archive.id,
      type: "geovideo",
      title: archive.title,
      provenance: undefined,
      temporal: {
        mode: "fixed",
        cadence: "P1M",
        start: "2010-01-16T12:00:00Z",
        end: "2019-12-16T12:00:00Z",
      },
      manifestUrl:
        "https://example.test/geovideo/entry/source/abc/manifest.json",
    });
    expect(isGeoVideoArchiveSource(archive)).toBe(true);
    expect(isGeoVideoArchiveSource(chunk)).toBe(false);
  });

  it("rejects an index written for another entry or source", () => {
    expect(() =>
      geoVideoChunkSources(archive, { ...index(), sourceId: "other" }, entry),
    ).toThrow(/identity/);
    expect(() =>
      geoVideoChunkSources(
        archive,
        { ...index(), catalogEntryId: "other" },
        entry,
      ),
    ).toThrow(/identity/);
  });

  it("validates the index shape and chunk periods", () => {
    expect(validateGeoVideoIndex(index([{}])).chunks).toHaveLength(1);
    expect(() =>
      validateGeoVideoIndex({ ...index(), schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      validateGeoVideoIndex(
        index([{ start: "2020-01-01", end: "2019-01-01" }]),
      ),
    ).toThrow(/chunk/);
    expect(() => validateGeoVideoIndex(index([{ start: "soon" }]))).toThrow(
      /chunk/,
    );
  });

  it("tells chunks of one archive apart by manifest", () => {
    const [first, second] = geoVideoChunkSources(
      archive,
      index([{}, { key: "def", manifestUrl: "def/manifest.json" }]),
      entry,
    );
    expect(isSameSource(first, { ...first })).toBe(true);
    expect(isSameSource(first, second)).toBe(false);
  });
});
