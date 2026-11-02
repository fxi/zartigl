import { describe, expect, it } from "vitest";
import { parseMp4VideoTrack } from "./mp4";
import { mp4Fixture as fixture } from "./mp4.fixture";

describe("parseMp4VideoTrack", () => {
  it("reads the decoder configuration", () => {
    const track = parseMp4VideoTrack(fixture());
    expect(track.codec).toMatch(/^avc1\.64[0-9a-f]{4}$/);
    expect(track.description[0]).toBe(1);
    expect([track.width, track.height]).toEqual([32, 16]);
  });

  it("lists samples in decode order with their presented frame", () => {
    const { samples } = parseMp4VideoTrack(fixture());
    expect(samples.map((s) => s.frame)).toEqual([0, 4, 2, 1, 3, 6, 5]);
    expect(samples.map((s) => s.key)).toEqual([
      true, false, false, false, false, false, false,
    ]);
    expect(samples.map((s) => [s.offset, s.size])).toEqual([
      [956, 1309], [2265, 12], [2277, 12], [2289, 12],
      [2301, 12], [2313, 15], [2328, 12],
    ]);
  });

  it("rejects an edit list trimming frames", () => {
    const buffer = fixture();
    const bytes = new Uint8Array(buffer);
    const elst = bytes.findIndex(
      (_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === "elst",
    );
    // Version 0 entry after version/flags and count: duration, media_time.
    const view = new DataView(buffer);
    const mediaTime = elst + 4 + 4 + 4 + 4;
    view.setInt32(mediaTime, view.getInt32(mediaTime) + 512);
    expect(() => parseMp4VideoTrack(buffer)).toThrow(/edit list/);
  });

  it("rejects a file without a movie box", () => {
    expect(() => parseMp4VideoTrack(new ArrayBuffer(16))).toThrow(/moov/);
  });
});
