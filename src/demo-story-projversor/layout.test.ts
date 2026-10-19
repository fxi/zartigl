import { describe, expect, it } from "vitest";
import {
  LAYOUT_IDS,
  insetRect,
  limbShape,
  mapInset,
  overlap,
  resolveLayout,
  textZone,
  veilStops,
} from "./layout";

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
  landscape: { width: 844, height: 390 },
};

describe("resolveLayout", () => {
  it("folds side and corner layouts to top or bottom in portrait", () => {
    const phone = VIEWPORTS.phone;
    expect(resolveLayout("w-e", phone).variant).toBe("n-s");
    expect(resolveLayout("nw-se", phone).variant).toBe("n-s");
    expect(resolveLayout("e-w", phone).variant).toBe("s-n");
    expect(resolveLayout("se-nw", phone).variant).toBe("s-n");
    expect(resolveLayout("title", phone).variant).toBe("title");
  });

  it("puts the text beside the map on a short landscape screen", () => {
    expect(resolveLayout("n-s", VIEWPORTS.landscape).variant).toBe("w-e");
    expect(resolveLayout("end", VIEWPORTS.landscape).variant).toBe("e-w");
  });

  it("keeps every layout on desktop, right-aligned on the east side", () => {
    for (const id of LAYOUT_IDS) {
      expect(resolveLayout(id, VIEWPORTS.desktop).variant).toBe(id);
    }
    expect(resolveLayout("e-w", VIEWPORTS.desktop)).toMatchObject({
      align: "end",
      edge: "left",
    });
  });
});

describe("text zone and map free zone", () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    for (const id of LAYOUT_IDS) {
      it(`${id} on ${name}: never overlap, map keeps 40% of the screen`, () => {
        const { variant } = resolveLayout(id, viewport);
        const zone = textZone(variant, viewport);
        expect(zone.x).toBeGreaterThanOrEqual(0);
        expect(zone.y).toBeGreaterThanOrEqual(0);
        expect(zone.x + zone.width).toBeLessThanOrEqual(viewport.width);
        expect(zone.y + zone.height).toBeLessThanOrEqual(viewport.height);
        const free = insetRect(viewport, mapInset(variant, viewport, zone));
        expect(overlap(zone, free)).toBe(0);
        const share =
          (free.width * free.height) / (viewport.width * viewport.height);
        expect(share).toBeGreaterThanOrEqual(0.4);
      });
    }
  }

  it("shrinks the inset with a shorter measured text", () => {
    const viewport = VIEWPORTS.desktop;
    const zone = textZone("n-s", viewport);
    const short = { ...zone, height: zone.height / 2 };
    expect(mapInset("n-s", viewport, short).top).toBeLessThan(
      mapInset("n-s", viewport, zone).top,
    );
  });
});

describe("veilStops", () => {
  it("stays solid to the end of a top text, then fades", () => {
    const viewport = { width: 1000, height: 1000 };
    const text = { x: 0, y: 0, width: 1000, height: 300 };
    expect(veilStops(180, viewport, text)).toEqual({ solid: 30, clear: 56 });
  });

  it("reaches the far corner of a corner text on a diagonal", () => {
    const viewport = { width: 1000, height: 1000 };
    const text = { x: 0, y: 0, width: 500, height: 500 };
    expect(veilStops(135, viewport, text).solid).toBeCloseTo(50, 0);
  });
});

describe("limbShape", () => {
  /** A circle of radius r around (cx, cy), as an outline. */
  const circle = (cx: number, cy: number, r: number) =>
    Array.from({ length: 64 }, (_, i): [number, number] => {
      const a = (i / 64) * 2 * Math.PI;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });

  it("follows the globe's near limb inside the text box", () => {
    const box = { x: 0, y: 0, width: 400, height: 400 };
    const shape = limbShape(circle(600, 200, 300), box, "right", 200)!;
    expect(shape).toMatch(/^polygon\(400px 0px, /);
    expect(shape).toContain("300px 200px");
    expect(shape).toMatch(/, 400px 400px\)$/);
  });

  it("is null when the globe stays out of the box", () => {
    const box = { x: 0, y: 0, width: 400, height: 400 };
    expect(limbShape(circle(900, 200, 300), box, "right")).toBeNull();
  });
});
