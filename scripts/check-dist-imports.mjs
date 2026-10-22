// Checks the import graph of the built entries, following their relative
// chunks, in their code and declarations: no entry loads @fxi/projversor
// (projversor depends on zartigl, never the reverse), and catalog, engine
// and story never load MapLibre, so projversor can use them. Run after
// `vite build --config vite.config.lib.ts` (npm run build:lib runs both).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const specifier =
  /(?:\bimport|\bexport)\s*(?:[^"'`;]*?\bfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const PROJVERSOR = /^@fxi\/projversor(?:\/|$)/;
const MAPLIBRE = /^maplibre-gl(?:\/|$)/;

const rules = {
  "zartigl.js": [PROJVERSOR],
  "catalog.js": [PROJVERSOR, MAPLIBRE],
  "engine.js": [PROJVERSOR, MAPLIBRE],
  "story.js": [PROJVERSOR, MAPLIBRE],
};

/** Bare imports reached from an entry, with the file importing each. */
function bareImports(entry) {
  const found = new Map();
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(specifier)) {
      const id = match[1] ?? match[2];
      if (id.startsWith(".")) {
        visit(join(dirname(file), id));
      } else if (!found.has(id)) {
        found.set(id, relative(dist, file));
      }
    }
  };
  visit(join(dist, entry));
  return found;
}

const errors = [];
for (const [entry, forbidden] of Object.entries(rules)) {
  if (!existsSync(join(dist, entry))) {
    errors.push(`missing dist/${entry}`);
    continue;
  }
  const declarations = entry.replace(/\.js$/, ".d.ts");
  const graph = new Map([
    ...bareImports(entry),
    ...(existsSync(join(dist, declarations)) ? bareImports(declarations) : []),
  ]);
  for (const [id, file] of graph) {
    if (forbidden.some((pattern) => pattern.test(id))) {
      errors.push(`dist/${entry} loads "${id}" (from dist/${file})`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`dist import graph checked: ${Object.keys(rules).join(", ")}`);
