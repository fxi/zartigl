import { describe, expect, it } from "vitest";
import { resolveTimeInputSelection } from "./time-selection";

describe("resolveTimeInputSelection", () => {
  it("keeps monthly selections inside the selected calendar month", () => {
    const values = [Date.UTC(2025, 0, 28), Date.UTC(2025, 1, 28)];

    expect(resolveTimeInputSelection(values, "2025-02", "month")).toBe(values[1]);
  });

  it("keeps daily selections inside the selected UTC day", () => {
    const values = [Date.UTC(2025, 0, 1, 23), Date.UTC(2025, 0, 2, 23)];

    expect(resolveTimeInputSelection(values, "2025-01-02", "day")).toBe(values[1]);
  });

  it("keeps annual selections inside the selected calendar year", () => {
    const values = [Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)];

    expect(resolveTimeInputSelection(values, "2025", "year")).toBe(values[1]);
  });

  it("falls back to the nearest timestamp for an empty calendar period", () => {
    const values = [Date.UTC(2025, 0, 28), Date.UTC(2025, 2, 28)];

    expect(resolveTimeInputSelection(values, "2025-02", "month")).toBe(values[0]);
  });
});
