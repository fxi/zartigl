import { describe, expect, it } from "vitest";
import type { CatalogGeoVideoSource } from "../catalog/types";
import { archiveChunkAt, nextChunk, pairChunk } from "./archive-timeline";

const chunk = (
  start: string,
  end: string,
  id = "source",
): CatalogGeoVideoSource => ({
  id,
  type: "geovideo",
  title: { en: "Chunk" },
  temporal: { mode: "fixed", start, end },
  manifestUrl: `https://example.test/${id}/${start}/manifest.json`,
});

const ms = (iso: string) => Date.parse(iso);

describe("nextChunk", () => {
  const august = chunk("2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z");
  const september = chunk("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z");
  const october = chunk("2026-10-01T00:00:00Z", "2026-10-11T00:00:00Z");
  const other = chunk("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z", "other");
  // Unsorted, with another archive's chunk mixed in.
  const chunks = [october, other, august, september];

  it("follows the current chunk of the same archive", () => {
    expect(nextChunk(chunks, august)).toEqual({
      source: september,
      time: ms("2026-09-01T00:00:00Z"),
    });
  });

  it("stops at the end without loop, restarts with it", () => {
    expect(nextChunk(chunks, october)).toBeNull();
    expect(nextChunk(chunks, october, { loop: true })?.source).toBe(august);
  });

  it("stays inside the time range and resumes at its start", () => {
    const range = [ms("2026-08-15T00:00:00Z"), ms("2026-09-15T00:00:00Z")] as [
      number,
      number,
    ];
    expect(nextChunk(chunks, september, { range })).toBeNull();
    expect(nextChunk(chunks, september, { range, loop: true })).toEqual({
      source: august,
      time: range[0],
    });
  });
});

describe("pairChunk", () => {
  it("pairs months sampled at different hours", () => {
    // Six-hourly currents from 00:00, daily temperature at 12:00.
    const currents = chunk("2026-09-01T00:00:00Z", "2026-09-30T18:00:00Z");
    const august = chunk("2026-08-01T12:00:00Z", "2026-08-31T12:00:00Z");
    const september = chunk("2026-09-01T12:00:00Z", "2026-09-30T12:00:00Z");
    expect(pairChunk(currents, [august, september])).toBe(september);
  });

  it("pairs a single-sample month contained in the other range", () => {
    const one = chunk("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
    const october = chunk("2026-10-01T00:00:00Z", "2026-10-11T00:00:00Z");
    expect(pairChunk(one, [october])).toBe(october);
  });

  it("returns null when no month overlaps", () => {
    const currents = chunk("2026-09-01T00:00:00Z", "2026-09-30T18:00:00Z");
    const august = chunk("2026-08-01T12:00:00Z", "2026-08-31T12:00:00Z");
    expect(pairChunk(currents, [august])).toBeNull();
  });
});

describe("archiveChunkAt", () => {
  const november = chunk("2024-11-01T00:00:00Z", "2024-11-30T21:00:00Z");
  const december = chunk("2024-12-01T00:00:00Z", "2024-12-31T21:00:00Z");
  const chunks = [december, november];

  it("picks the chunk holding the time", () => {
    expect(archiveChunkAt(chunks, { time: ms("2024-12-21T16:00:00Z") })).toBe(
      december,
    );
  });

  it("snaps a time between or beyond chunks to the nearest one", () => {
    // After the last sample of a month, before the next month's first.
    expect(archiveChunkAt(chunks, { time: ms("2024-11-30T22:00:00Z") })).toBe(
      november,
    );
    expect(archiveChunkAt(chunks, { time: ms("2024-11-30T23:00:00Z") })).toBe(
      december,
    );
    expect(archiveChunkAt(chunks, { time: ms("2020-07-01T00:00:00Z") })).toBe(
      november,
    );
  });

  it("stays inside a window, the latest chunk without a time", () => {
    expect(archiveChunkAt(chunks)).toBe(december);
    const window = {
      start: ms("2024-11-10T00:00:00Z"),
      end: ms("2024-11-20T00:00:00Z"),
    };
    expect(archiveChunkAt(chunks, window)).toBe(november);
    expect(
      archiveChunkAt(chunks, { ...window, time: ms("2024-12-21T00:00:00Z") }),
    ).toBe(november);
    expect(
      archiveChunkAt(chunks, { start: ms("2025-01-05T00:00:00Z") }),
    ).toBeUndefined();
  });
});
