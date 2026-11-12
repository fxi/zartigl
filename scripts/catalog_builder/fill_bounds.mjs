#!/usr/bin/env node
/**
 * Copy the extent of every GeoVideo source into the catalog: `bounds`
 * (west, south, east, north) from its manifest, or from the manifest of the
 * latest chunk of its archive index. Apps use it to tell which layers overlap
 * without reading the archives.
 *
 *   node scripts/catalog_builder/fill_bounds.mjs [--all]
 *
 * Sources that already have bounds are skipped unless `--all` is given.
 */

import { readFile, writeFile } from "node:fs/promises";

const CATALOG = new URL("../../src/catalog/catalog.json", import.meta.url);
const all = process.argv.includes("--all");

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function manifestUrl(source) {
  if (source.manifestUrl) {
    return source.manifestUrl;
  }
  const index = await fetchJson(source.indexUrl);
  const chunk = index.chunks?.at(-1);
  if (!chunk) {
    throw new Error(`empty index ${source.indexUrl}`);
  }
  return new URL(chunk.manifestUrl, source.indexUrl).href;
}

const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
const failures = [];
let filled = 0;
await Promise.all(
  catalog.layers.flatMap((entry) =>
    entry.sources
      .filter((s) => s.type === "geovideo" && (all || !s.bounds))
      .map(async (source) => {
        const name = entry.aliases?.[0] ?? entry.id;
        try {
          const manifest = await fetchJson(await manifestUrl(source));
          const bounds = manifest.bounds;
          if (!Array.isArray(bounds) || bounds.length !== 4) {
            throw new Error("manifest without bounds");
          }
          source.bounds = bounds.map(Number);
          filled++;
        } catch (error) {
          failures.push(`${name} ${source.id}: ${error.message}`);
        }
      }),
  ),
);
await writeFile(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`bounds filled on ${filled} GeoVideo sources`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
