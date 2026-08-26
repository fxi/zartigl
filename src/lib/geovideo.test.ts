import { describe, expect, it } from "vitest";
import {
  geoVideoSecondsForTime,
  geoVideoTimeForSeconds,
  geoVideoTimelineValues,
  loadGeoVideoManifest,
  validateGeoVideoManifest,
  type GeoVideoManifest,
} from "./geovideo";

const manifest: GeoVideoManifest = {
  schemaVersion: 2,
  id: "sst-values",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -90, 180, 90],
  media: {
    url: "video.mp4", mimeType: "video/mp4", width: 2048, height: 1024,
    fps: 24, durationSeconds: 30, codec: "h264",
  },
  encoding: {
    kind: "scalar-luma", bits: 8, codeMin: 8, codeMax: 247,
    valueMin: -3, valueMax: 3, transfer: "linear", colorSpace: "bt709", colorRange: "limited",
  },
  mask: {
    kind: "static-validity", url: "mask.png", mimeType: "image/png",
    width: 2048, height: 1024, threshold: 0.5,
  },
  timeline: {
    kind: "range",
    dateStart: "2026-01-01T00:00:00Z",
    dateEnd: "2026-07-01T00:00:00Z",
    interpolation: "linear",
  },
  provenance: {
    layerId: "sea-surface-temperature-anomaly",
    datasetId: "dataset",
    variable: "sea_surface_temperature_anomaly",
    generatedAt: "2026-07-02T00:00:00Z",
  },
  style: { palette: "balance", colorDomain: [-3, 3], unit: "degrees_C" },
};

describe("GeoVideo manifest", () => {
  it("validates a scalar-luma video with an external static mask", () => {
    expect(validateGeoVideoManifest(manifest)).toEqual(manifest);
  });

  it("rejects the removed v1 format", () => {
    expect(() => validateGeoVideoManifest({
      ...manifest,
      schemaVersion: 1,
    })).toThrow(/version/);
  });

  it("rejects scalar-luma masks whose dimensions differ from the media", () => {
    expect(() => validateGeoVideoManifest({
      ...manifest,
      mask: { ...manifest.mask, width: 1024 },
    })).toThrow(/mask/);
  });

  it("resolves both scalar-luma assets relative to the manifest", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => manifest }) as Response;
    try {
      const loaded = await loadGeoVideoManifest("https://cdn.test/artifact/manifest.json");
      expect(loaded.media.url).toBe("https://cdn.test/artifact/video.mp4");
      expect(loaded.schemaVersion).toBe(2);
      expect(loaded.mask.url).toBe("https://cdn.test/artifact/mask.png");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("maps scientific dates to media time and back", () => {
    const timeline = manifest.timeline.kind === "range" ? manifest.timeline : null;
    const start = new Date(timeline!.dateStart).getTime();
    const end = new Date(timeline!.dateEnd).getTime();
    const middle = (start + end) / 2;
    const seconds = geoVideoSecondsForTime(manifest, middle);
    expect(seconds).toBeCloseTo(15 - 1 / 48);
    expect(geoVideoTimeForSeconds(manifest, seconds)).toBeCloseTo(middle);
  });

  it("derives one scientific timestamp per encoded frame", () => {
    const values = geoVideoTimelineValues({
      ...manifest,
      media: { ...manifest.media, fps: 2, durationSeconds: 3 },
    });
    expect(values).toHaveLength(6);
    expect(values[0]).toBe(new Date("2026-01-01T00:00:00Z").getTime());
    expect(values[values.length - 1]).toBe(new Date("2026-07-01T00:00:00Z").getTime());
  });

  it("maps discrete sample sequences without inventing intermediate dates", () => {
    const samples: GeoVideoManifest = {
      ...manifest,
      media: { ...manifest.media, durationSeconds: 3 },
      timeline: {
        kind: "sample-sequence",
        values: [
          "1993-09-01T00:00:00Z",
          "1994-09-01T00:00:00Z",
          "1995-09-01T00:00:00Z",
        ],
      },
    };
    const values = geoVideoTimelineValues(samples);
    expect(values).toEqual(samples.timeline.kind === "sample-sequence"
      ? samples.timeline.values.map(Date.parse)
      : []);
    expect(geoVideoTimeForSeconds(samples, 0)).toBe(values[0]);
    expect(geoVideoTimeForSeconds(samples, 1.2)).toBe(values[1]);
    expect(geoVideoTimeForSeconds(samples, 2.99)).toBe(values[2]);
    expect(geoVideoSecondsForTime(samples, Date.parse("1994-08-01T00:00:00Z"))).toBeCloseTo(1 + 1 / 48);
  });

  it("rejects empty or unordered sample sequences", () => {
    expect(() => validateGeoVideoManifest({
      ...manifest,
      timeline: { kind: "sample-sequence", values: [] },
    })).toThrow(/contain values/);
    expect(() => validateGeoVideoManifest({
      ...manifest,
      timeline: {
        kind: "sample-sequence",
        values: ["1995-09-01T00:00:00Z", "1994-09-01T00:00:00Z"],
      },
    })).toThrow(/strictly increasing/);
  });
});
