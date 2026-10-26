import { describe, expect, it } from "vitest";
import { parseTimeRange, timeRangeBounds } from "./time-range";

const MAY = Date.UTC(2026, 4, 1);
const OCT = Date.UTC(2026, 9, 31);
const SOURCE = [Date.UTC(2026, 0, 1), Date.UTC(2026, 9, 15)] as const;

describe("timeRangeBounds", () => {
  it("clamps a fixed range to the available times", () => {
    expect(
      timeRangeBounds({ start: "2026-05-01", end: "2026-10-31" }, SOURCE),
    ).toEqual([MAY, SOURCE[1]]);
  });

  it("takes the available bound for an open side", () => {
    expect(timeRangeBounds({ start: "2026-05-01" }, SOURCE)).toEqual([
      MAY,
      SOURCE[1],
    ]);
    expect(timeRangeBounds({}, SOURCE)).toEqual([...SOURCE]);
  });

  it("counts a trailing range back from the latest time", () => {
    expect(timeRangeBounds({ trailing: "P3M" }, SOURCE)).toEqual([
      Date.UTC(2026, 6, 15),
      SOURCE[1],
    ]);
  });

  it("rejects a start after its end", () => {
    expect(() =>
      timeRangeBounds({ start: "2026-10-31", end: "2026-05-01" }, SOURCE),
    ).toThrow(/must not follow/);
  });
});

describe("parseTimeRange", () => {
  it("keeps the given bounds only", () => {
    expect(parseTimeRange({ start: "2026-05-01" }, "range")).toEqual({
      start: "2026-05-01",
    });
    expect(
      parseTimeRange({ start: "2026-05-01", end: "2026-10-31" }, "range"),
    ).toEqual({ start: "2026-05-01", end: "2026-10-31" });
    expect(parseTimeRange({ trailing: "P6M" }, "range")).toEqual({
      trailing: "P6M",
    });
  });

  it("rejects malformed ranges with their path", () => {
    expect(() => parseTimeRange([], "v.timeRange")).toThrow(
      "v.timeRange must be an object",
    );
    expect(() => parseTimeRange({ from: "2026" }, "v.timeRange")).toThrow(
      "v.timeRange.from is not a time range key",
    );
    expect(() => parseTimeRange({ start: "soon" }, "v.timeRange")).toThrow(
      "v.timeRange.start is not a date",
    );
    expect(() =>
      parseTimeRange({ start: "2026-10-31", end: "2026-05-01" }, "r"),
    ).toThrow("r.start must not follow its end");
    expect(() =>
      parseTimeRange({ trailing: "P6M", start: "2026-05-01" }, "r"),
    ).toThrow("r.trailing excludes start and end");
    expect(() => parseTimeRange({ trailing: "6 months" }, "r")).toThrow(
      /Invalid trailing/,
    );
  });
});
