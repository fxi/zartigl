import { describe, expect, it } from "vitest";
import storyJson from "../story.json";
import viewsJson from "../views.json";
import trackJson from "./chido-track.json";
import { nearestChidoTrackPoint } from "../adapters/ZartiglStoryView";
import type { StoryDocument } from "../runtime";

describe("Chido story track", () => {
  it("uses the same 3-hour timestamps for playback and track points", () => {
    const mayotte = (storyJson as unknown as StoryDocument).scenes.find((scene) => scene.id === "mayotte")!;
    const playback = mayotte.playback;
    if (!playback || playback.mode !== "sequence") throw new Error("Mayotte must use sequence playback");
    expect(playback.direction).toBe("loop");
    expect(playback.times).toEqual(trackJson.points.map((point) => point.time));
    expect(playback.times[0]).toBe("2024-12-14T00:00:00.000Z");
    expect(playback.times[playback.times.length - 1]).toBe("2024-12-14T21:00:00.000Z");
  });

  it("extends the canonical IBTrACS track through 21 UTC", () => {
    expect(trackJson.source.positionColumns).toEqual(["LAT", "LON"]);
    expect(trackJson.points[trackJson.points.length - 1]).toMatchObject({ label: "21 UTC", longitude: 42.1, latitude: -13.2 });
  });

  it("selects the official point nearest the displayed wind frame", () => {
    const nativeTime = Date.parse("2024-12-14T21:00:48.000Z");
    expect(nearestChidoTrackPoint(trackJson.points, nativeTime).label).toBe("21 UTC");
  });

  it("keeps the Zartigl window wide enough for the final native frame", () => {
    const view = viewsJson.views.find((candidate) => candidate.id === "mayotte-wind")!;
    expect(view.config.timeRange).toEqual({
      start: "2024-12-14T00:00:00.000Z",
      end: "2024-12-14T22:00:00.000Z",
    });
  });
});
