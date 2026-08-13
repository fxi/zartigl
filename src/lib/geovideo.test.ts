import { describe, expect, it } from "vitest";
import {
  geoVideoSecondsForTime,
  geoVideoTimeForSeconds,
  geoVideoTimelineValues,
  validateGeoVideoManifest,
  type GeoVideoManifestV1,
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
