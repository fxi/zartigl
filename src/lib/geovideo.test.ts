import { describe, expect, it } from "vitest";
import {
  geoVideoSecondsForTime,
  geoVideoTimeForSeconds,
  geoVideoTimelineValues,
  loadGeoVideoManifest,
  validateGeoVideoManifest,
  type GeoVideoManifestV1,
  type GeoVideoManifestV2,
} from "./geovideo";

const manifest: GeoVideoManifestV1 = {
  schemaVersion: 1,
  id: "sst-six-months",
  type: "geovideo",
  projection: "equirectangular",
  bounds: [-180, -90, 180, 90],
  media: {
    url: "sst.mp4",
    mimeType: "video/mp4",
    width: 2048,
    height: 1024,
    packedWidth: 4096,
    packedHeight: 1024,
    fps: 24,
    durationSeconds: 30,
    codec: "h264",
    alpha: "side-by-side",
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

const scalarLumaManifest: GeoVideoManifestV2 = {
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
  timeline: manifest.timeline,
  provenance: manifest.provenance,
  style: manifest.style,
};

describe("GeoVideo manifest", () => {
  it("validates a global side-by-side MP4", () => {
    expect(validateGeoVideoManifest(manifest)).toEqual(manifest);
  });

  it("rejects inconsistent packed dimensions", () => {
    expect(() => validateGeoVideoManifest({
      ...manifest,
      media: { ...manifest.media, packedWidth: 2048 },
    })).toThrow(/dimensions/);
  });

  it("validates scalar-luma video with an external static mask", () => {
    expect(validateGeoVideoManifest(scalarLumaManifest)).toEqual(scalarLumaManifest);
  });

  it("rejects scalar-luma masks whose dimensions differ from the media", () => {
    expect(() => validateGeoVideoManifest({
      ...scalarLumaManifest,
      mask: { ...scalarLumaManifest.mask, width: 1024 },
    })).toThrow(/mask/);
  });

  it("resolves both scalar-luma assets relative to the manifest", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => scalarLumaManifest }) as Response;
    try {
      const loaded = await loadGeoVideoManifest("https://cdn.test/artifact/manifest.json");
      expect(loaded.media.url).toBe("https://cdn.test/artifact/video.mp4");
      expect(loaded.schemaVersion).toBe(2);
      if (loaded.schemaVersion === 2) {
        expect(loaded.mask.url).toBe("https://cdn.test/artifact/mask.png");
      }
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
});
