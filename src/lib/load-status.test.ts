import { describe, expect, it } from "vitest";
import {
  hasRenderableScalar,
  hasRenderableVector,
  ZartiglFrameUnavailableError,
} from "./load-status";

describe("frame availability", () => {
  it("requires a finite scalar or paired vector sample", () => {
    expect(hasRenderableScalar(new Float32Array([NaN, NaN]))).toBe(false);
    expect(hasRenderableScalar(new Float32Array([NaN, 0]))).toBe(true);
    expect(hasRenderableVector(
      new Float32Array([1, NaN]),
      new Float32Array([NaN, 2]),
    )).toBe(false);
    expect(hasRenderableVector(
      new Float32Array([1, NaN]),
      new Float32Array([2, NaN]),
    )).toBe(true);
  });

  it("deduplicates remote status codes and URLs", () => {
    const error = new ZartiglFrameUnavailableError(
      123,
      [404, 403, 403],
      ["a", "a", "b"],
    );

    expect(error.statuses).toEqual([403, 404]);
    expect(error.urls).toEqual(["a", "b"]);
  });
});
