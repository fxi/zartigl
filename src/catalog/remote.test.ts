import { describe, expect, it } from "vitest";
import { version } from "../../package.json";
import { catalog } from "./index";
import { CATALOG_URL, compareVersions, loadCatalog } from "./remote";

const remote = { ...catalog, layers: catalog.layers.slice(0, 1) };

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("compareVersions", () => {
  it("orders x.y.z numerically", () => {
    expect(compareVersions("0.9.3", "0.10.0")).toBe(-1);
    expect(compareVersions("0.10.1", "0.10.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("loadCatalog", () => {
  it("reads the live schema 2 catalog", async () => {
    const warnings: string[] = [];
    const loaded = await loadCatalog(CATALOG_URL, {
      fetch: respond(remote),
      warn: (message) => warnings.push(message),
    });
    expect(loaded.source).toBe("remote");
    expect(loaded.catalog.layers).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("falls back to the bundled catalog on a network or HTTP error", async () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    for (const fetch of [offline, respond({}, 404)]) {
      const loaded = await loadCatalog(CATALOG_URL, { fetch, warn });
      expect(loaded).toEqual({ catalog, source: "bundled" });
    }
    expect(warnings[0]).toContain("Failed to fetch");
    expect(warnings[1]).toContain("HTTP 404");
  });

  it("falls back on another schema, and gives up after the timeout", async () => {
    const warn = () => undefined;
    expect(
      (
        await loadCatalog(CATALOG_URL, {
          fetch: respond({ ...remote, schemaVersion: 3 }),
          warn,
        })
      ).source,
    ).toBe("bundled");
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      )) as unknown as typeof fetch;
    expect(
      (await loadCatalog(CATALOG_URL, { fetch: hanging, warn, timeoutMs: 10 }))
        .source,
    ).toBe("bundled");
  });

  it("warns when the catalog needs a newer engine, and still uses it", async () => {
    const warnings: string[] = [];
    const loaded = await loadCatalog(CATALOG_URL, {
      fetch: respond({ ...remote, minEngine: "99.0.0" }),
      warn: (message) => warnings.push(message),
    });
    expect(loaded.source).toBe("remote");
    expect(warnings).toEqual([
      `[zartigl] the catalog at ${CATALOG_URL} needs zartigl 99.0.0; this is ${version}: newer style keys are ignored`,
    ]);
  });
});
