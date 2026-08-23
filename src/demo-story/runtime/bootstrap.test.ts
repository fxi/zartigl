import { describe, expect, it } from "vitest";
import { initializeAfterStaticRender } from "./bootstrap";

describe("initializeAfterStaticRender", () => {
  it("renders before asynchronous map initialization settles", async () => {
    let rendered = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const startup = initializeAfterStaticRender(
      () => { rendered = true; },
      async () => {
        expect(rendered).toBe(true);
        await pending;
        return "ready";
      },
    );

    expect(rendered).toBe(true);
    release();
    await expect(startup).resolves.toBe("ready");
  });

  it("keeps the static render when initialization fails", async () => {
    let rendered = false;
    const startup = initializeAfterStaticRender(
      () => { rendered = true; },
      async () => { throw new Error("map failed"); },
    );

    await expect(startup).rejects.toThrow("map failed");
    expect(rendered).toBe(true);
  });
});
