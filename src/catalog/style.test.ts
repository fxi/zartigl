import { describe, expect, it } from "vitest";
import schema from "../../scripts/catalog_builder/schema.json";
import zartiglMapSchema from "../demo-story/schemas/zartigl-map.schema.json";
import zartiglMapViews from "../demo-story/views.json";
import { catalog } from "./index";
import {
  LAYER_STYLE_DEFAULTS,
  PARTICLE_STYLE_KEYS,
  RASTER_STYLE_KEYS,
  mergeStyles,
  parseLayerStyle,
  resolveEntryStyle,
  resolveLayerStyle,
  styleForKind,
} from "./style";

describe("resolveLayerStyle", () => {
  it("starts from the engine defaults", () => {
    expect(resolveLayerStyle()).toEqual(LAYER_STYLE_DEFAULTS);
  });

  it("merges each group key by key, later inputs winning", () => {
    const style = resolveLayerStyle(
      { palette: "rdylbu", particles: { density: 0.004, fade: 0.5 } },
      { palette: "thermal", particles: { fade: 0.9 } },
      { particles: { speed: 2 }, raster: { opacity: 0.5 } },
    );
    expect(style.palette).toBe("thermal");
    expect(style.particles).toEqual({
      density: 0.004,
      speed: 2,
      fade: 0.9,
      grade: "off",
      backdrop: LAYER_STYLE_DEFAULTS.particles.backdrop,
    });
    expect(style.raster.opacity).toBe(0.5);
    expect(style.raster.vibrance).toBe(0);
  });

  it("ignores undefined values and does not mutate the defaults", () => {
    const style = resolveLayerStyle({ particles: { density: undefined } });
    style.particles.density = 1;
    expect(resolveLayerStyle().particles.density).toBe(0.05);
  });

  it("reads catalog defaults directly", () => {
    const entry = catalog.layers.find((e) =>
      e.aliases?.includes("primary-swell-propagation"),
    );
    expect(resolveLayerStyle(entry?.defaults).particles.density).toBe(0.03);
  });
});

describe("grade", () => {
  it("is a preset or a tuned vibrant grade, replaced as a whole", () => {
    const style = resolveLayerStyle(
      { particles: { grade: { contrast: 0.2, exposure: 1 } } },
      { particles: { grade: { saturation: 0.1 } } },
    );
    expect(style.particles.grade).toEqual({ saturation: 0.1 });
    expect(() =>
      parseLayerStyle({ particles: { grade: { contrast: 0.5 } } }, "s"),
    ).not.toThrow();
    expect(() =>
      parseLayerStyle({ particles: { grade: { contrast: 2 } } }, "s"),
    ).toThrow("s.particles.grade must be");
    expect(() =>
      parseLayerStyle({ particles: { grade: { glow: 1 } } }, "s"),
    ).toThrow("s.particles.grade must be");
  });
});

describe("backdrop", () => {
  it("is off by default and replaced as a whole, on when given", () => {
    expect(resolveLayerStyle().particles.backdrop).toEqual({
      enabled: false,
      color: "#000000",
      opacity: 0.5,
    });
    expect(LAYER_STYLE_DEFAULTS.particles.backdrop.enabled).toBe(false);
    const style = resolveLayerStyle(
      { particles: { backdrop: { color: "#fff" } } },
      { particles: { backdrop: { opacity: 0.2 } } },
    );
    expect(style.particles.backdrop).toEqual({
      enabled: true,
      color: "#000000",
      opacity: 0.2,
    });
    expect(
      resolveLayerStyle({ particles: { backdrop: { enabled: false } } })
        .particles.backdrop.enabled,
    ).toBe(false);
    expect(
      mergeStyles(
        { particles: { backdrop: { color: "#fff" } } },
        { particles: { backdrop: { opacity: 1 } } },
      ),
    ).toEqual({ particles: { backdrop: { opacity: 1 } } });
  });
});

describe("mergeStyles", () => {
  it("patches groups key by key without defaults", () => {
    expect(
      mergeStyles(
        { palette: "a", particles: { density: 0.1, fade: 0.5 } },
        { particles: { fade: 0.2, speed: undefined }, raster: {} },
        undefined,
      ),
    ).toEqual({ palette: "a", particles: { density: 0.1, fade: 0.2 } });
  });
});

describe("resolveEntryStyle and styleForKind", () => {
  it("draw a scalar layer as a raster without particles", () => {
    const scalar = { kind: "scalar" as const, defaults: { palette: "p" } };
    expect(resolveEntryStyle(scalar).renderMode).toBe("raster");
    expect(resolveEntryStyle(scalar, { palette: "q" }).palette).toBe("q");
    expect(
      styleForKind(
        {
          palette: "q",
          renderMode: "particles",
          particles: { density: 0.1 },
          raster: { opacity: 0.5 },
        },
        "scalar",
      ),
    ).toEqual({ palette: "q", raster: { opacity: 0.5 } });
    const vector = { renderMode: "particles" as const };
    expect(styleForKind(vector, "vector")).toBe(vector);
  });
});

describe("parseLayerStyle", () => {
  const path = "views.swell.config.style";

  it("accepts a valid style", () => {
    const style = {
      palette: "thermal",
      particles: { density: 0.03, speed: 1, fade: 0.7, grade: "vibrant" },
      raster: { opacity: 0.9, colorDomain: [0, 5] },
    };
    expect(parseLayerStyle(style, path, { kind: "vector" })).toBe(style);
    expect(() =>
      parseLayerStyle(
        {
          particles: {
            backdrop: { enabled: true, color: "#0B1A2A", opacity: 0.3 },
          },
        },
        path,
      ),
    ).not.toThrow();
  });

  it.each<[unknown, string]>([
    [{ particles: { density: 0 } }, `${path}.particles.density must be`],
    [{ particles: { density: 0.5 } }, `${path}.particles.density must be`],
    [{ particles: { speed: -1 } }, `${path}.particles.speed must be`],
    [{ particles: { fade: 2 } }, `${path}.particles.fade must be`],
    [{ particles: { grade: "loud" } }, `${path}.particles.grade must be`],
    [{ particles: { size: 1 } }, `${path}.particles.size is not a style key`],
    [{ raster: { colorDomain: [5, 0] } }, `${path}.raster.colorDomain must be`],
    ...[
      { color: "black" },
      { color: "#00000080" },
      { opacity: 2 },
      { enabled: 1 },
      { size: 1 },
      "on",
    ].map((backdrop): [unknown, string] => [
      { particles: { backdrop } },
      `${path}.particles.backdrop must be`,
    ]),
    [{ renderMode: "dots" }, `${path}.renderMode must be one of`],
    [{ speed: 1 }, `${path}.speed is not a style key`],
    [[], `${path} must be an object`],
  ])("rejects %j with its path", (style, message) => {
    expect(() => parseLayerStyle(style, path)).toThrow(message);
  });

  it("rejects particles on a scalar layer", () => {
    expect(() =>
      parseLayerStyle({ particles: { density: 0.1 } }, path, {
        kind: "scalar",
      }),
    ).toThrow(`${path}.particles needs a vector layer`);
  });

  it("rejects inherited object keys", () => {
    expect(() =>
      parseLayerStyle({ particles: { constructor: 1 } }, path),
    ).toThrow(`${path}.particles.constructor is not a style key`);
  });

  it("allows only the raster mode on a scalar layer", () => {
    expect(() =>
      parseLayerStyle({ renderMode: "particles" }, path, { kind: "scalar" }),
    ).toThrow(`${path}.renderMode must be "raster" on a scalar layer`);
    expect(() =>
      parseLayerStyle({ renderMode: "raster" }, path, { kind: "scalar" }),
    ).not.toThrow();
  });

  it("rejects keys the caller does not support", () => {
    const supports = { palette: true, particles: ["density"] as const };
    expect(() =>
      parseLayerStyle({ particles: { fade: 0.5 } }, path, { supports }),
    ).toThrow(`${path}.particles.fade is not supported here`);
    expect(() =>
      parseLayerStyle({ raster: { opacity: 1 } }, path, { supports }),
    ).toThrow(`${path}.raster.opacity is not supported here`);
  });
});

interface SchemaProperty {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  oneOf?: SchemaProperty[];
  properties?: Record<string, SchemaProperty>;
}

describe("style schemas", () => {
  const style = schema.$defs.Defaults.properties;

  it("are the same in the catalog and the zartigl-map view", () => {
    const view = zartiglMapSchema.properties.style.properties;
    expect(view.particles).toEqual(style.particles);
    expect(view.raster).toEqual(style.raster);
  });

  it("define the same keys as the TypeScript style", () => {
    expect(Object.keys(style.particles.properties).sort()).toEqual(
      [...PARTICLE_STYLE_KEYS].sort(),
    );
    expect(Object.keys(style.raster.properties).sort()).toEqual(
      [...RASTER_STYLE_KEYS].sort(),
    );
  });

  it("bound values as parseLayerStyle does", () => {
    const eps = 1e-9;
    const groups = {
      particles: style.particles.properties,
      raster: style.raster.properties,
    } as Record<string, Record<string, SchemaProperty>>;
    const probe = (
      p: SchemaProperty,
      at: string,
      wrap: (value: unknown) => unknown,
    ): void => {
      const parses = (value: unknown) => {
        try {
          parseLayerStyle(wrap(value), "style");
          return true;
        } catch {
          return false;
        }
      };
      for (const option of p.oneOf ?? []) {
        probe(option, at, wrap);
      }
      for (const [key, item] of Object.entries(p.properties ?? {})) {
        probe(item, `${at}.${key}`, (value) => wrap({ [key]: value }));
      }
      if (p.properties) {
        expect(parses({ unknown: 1 }), `${at}.unknown`).toBe(false);
      }
      for (const value of p.enum ?? []) {
        expect(parses(value), `${at} = ${value}`).toBe(true);
      }
      if (p.enum) {
        expect(parses("unknown"), at).toBe(false);
      }
      if (p.maximum !== undefined) {
        expect(parses(p.maximum), `${at} max`).toBe(true);
        expect(parses(p.maximum + eps), `${at} above max`).toBe(false);
      }
      if (p.minimum !== undefined) {
        expect(parses(p.minimum), `${at} min`).toBe(true);
        expect(parses(p.minimum - eps), `${at} below min`).toBe(false);
      }
      if (p.exclusiveMinimum !== undefined) {
        expect(parses(p.exclusiveMinimum), `${at} min`).toBe(false);
        expect(parses(p.exclusiveMinimum + eps), `${at} above min`).toBe(true);
      }
    };
    for (const [group, properties] of Object.entries(groups)) {
      for (const [key, p] of Object.entries(properties)) {
        probe(p, `${group}.${key}`, (value) => ({
          [group]: { [key]: value },
        }));
      }
    }
  });

  it("holds demo story styles that parse", () => {
    for (const view of zartiglMapViews.views) {
      const config = view.config as { layerId?: string; style?: unknown };
      if (config.style !== undefined) {
        const kind = catalog.layers.find((e) => e.id === config.layerId)?.kind;
        expect(() =>
          parseLayerStyle(config.style, `views.${view.id}.config.style`, {
            kind,
          }),
        ).not.toThrow();
      }
    }
  });

  it("holds catalog defaults that parse as styles", () => {
    for (const entry of catalog.layers) {
      const { sourceId: _s, querySourceId: _q, ...style } = entry.defaults;
      expect(() =>
        parseLayerStyle(style, `${entry.id}.defaults`, { kind: entry.kind }),
      ).not.toThrow();
    }
  });
});
