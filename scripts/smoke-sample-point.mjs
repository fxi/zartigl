#!/usr/bin/env node
import { catalog, ZarrSource } from "../dist/zartigl.js";

const scenarios = [
  {
    name: "ocean-current-time",
    view: "ocean-current-velocity",
    mode: "time",
    lon: -2.594,
    lat: 35.986,
    expect: "valid",
  },
  {
    name: "ocean-current-depth",
    view: "ocean-current-velocity",
    mode: "depth",
    lon: -2.594,
    lat: 35.986,
    expect: "valid",
  },
  {
    name: "phytoplankton-time",
    view: "phytoplankton-chlorophyll",
    mode: "time",
    lon: -4.539,
    lat: 35.849,
    expect: "valid",
  },
  {
    name: "surface-wind-missing",
    view: "surface-wind",
    mode: "time",
    lon: -6.609,
    lat: 35.976,
    expect: "missing",
  },
  {
    name: "wave-stokes-time",
    view: "wave-stokes-drift",
    mode: "time",
    lon: 10.581,
    lat: 42.487,
    expect: "valid",
  },
];

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/smoke-sample-point.mjs",
      "  node scripts/smoke-sample-point.mjs --view <id> --mode <time|depth> --lon <n> --lat <n> [--expect valid|missing|any]",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  if (argv.length === 0) return null;
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      usage();
      process.exit(2);
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      usage();
      process.exit(2);
    }
    args[key] = value;
  }
  for (const key of ["view", "mode", "lon", "lat"]) {
    if (args[key] == null) {
      usage();
      process.exit(2);
    }
  }
  return [{
    name: `${args.view}-${args.mode}`,
    view: args.view,
    mode: args.mode,
    lon: Number(args.lon),
    lat: Number(args.lat),
    expect: args.expect ?? "any",
  }];
}

function pointVariables(view) {
  if (view.type === "scalar") return [view.variable ?? "scalar"];
  return [view.variable_u ?? "uo", view.variable_v ?? "vo"];
}

function hasDepthProfile(view) {
  const vertical = Object.values(view.dimensions).find((d) => d.axis === "z");
  return (vertical?.size ?? vertical?.values?.length ?? 0) > 1;
}

function sampleWindow(view, maxPoints = 24) {
  const time = view.dimensions.time;
  const size = time.size ?? 1;
  const end = size - 1;
  const start = Math.max(0, end - maxPoints + 1);
  return { start, end };
}

function valuesForPoint(point, variables, isVector) {
  if (!isVector) return [point.values[variables[0]]];
  const u = point.values[variables[0]];
  const v = point.values[variables[1]];
  return [
    Number.isFinite(u) && Number.isFinite(v) ? Math.hypot(u, v) : NaN,
    u,
    v,
  ];
}

function summarize(result, view, scenario) {
  const variables = pointVariables(view);
  const isVector = view.type === "vector";
  const samples = result.points.map((point) => valuesForPoint(point, variables, isVector)[0]);
  const valid = samples.filter(Number.isFinite);
  const firstValid = valid[0] ?? null;
  const min = valid.length ? Math.min(...valid) : null;
  const max = valid.length ? Math.max(...valid) : null;

  return {
    scenario: scenario.name,
    view: view.id,
    mode: scenario.mode,
    requested: { longitude: scenario.lon, latitude: scenario.lat },
    nearest: { longitude: result.longitude, latitude: result.latitude },
    count: samples.length,
    validCount: valid.length,
    missingCount: samples.length - valid.length,
    firstValid,
    min,
    max,
    variables,
    unit: view.variable_meta?.units ?? "",
  };
}

async function runScenario(catalog, scenario) {
  const view = catalog.views.find((candidate) => candidate.id === scenario.view);
  if (!view) throw new Error(`Unknown view: ${scenario.view}`);
  if (!view.zarr_url_time) throw new Error(`View has no zarr_url_time: ${view.id}`);
  if (scenario.mode !== "time" && scenario.mode !== "depth") {
    throw new Error(`Invalid mode: ${scenario.mode}`);
  }
  if (scenario.mode === "depth" && !hasDepthProfile(view)) {
    return {
      scenario: scenario.name,
      view: view.id,
      mode: scenario.mode,
      skipped: true,
      reason: "no vertical axis",
    };
  }

  const source = new ZarrSource(view.zarr_url_time, 80);
  const variables = pointVariables(view);
  const result = scenario.mode === "time"
    ? await source.sampleTimeSeries({
        variables,
        longitude: scenario.lon,
        latitude: scenario.lat,
        depth: 0,
        ...(() => {
          const window = sampleWindow(view);
          return {
            timeStartIndex: window.start,
            timeEndIndex: window.end,
          };
        })(),
        stopAfterMissingSamples: 8,
      })
    : await source.sampleVerticalProfile({
        variables,
        longitude: scenario.lon,
        latitude: scenario.lat,
        time: view.dimensions.time.max ?? Date.now(),
        stopAfterMissingSamples: 8,
      });

  const summary = summarize(result, view, scenario);
  if (scenario.expect === "valid" && summary.validCount === 0) {
    throw new Error(`${scenario.name}: expected valid samples, got none`);
  }
  if (scenario.expect === "missing" && summary.validCount !== 0) {
    throw new Error(`${scenario.name}: expected missing samples, got ${summary.validCount} valid`);
  }
  return summary;
}

const selected = parseArgs(process.argv.slice(2)) ?? scenarios;
const summaries = [];
let failed = false;

for (const scenario of selected) {
  try {
    const summary = await runScenario(catalog, scenario);
    summaries.push({ ok: true, ...summary });
    console.log(JSON.stringify({ ok: true, ...summary }));
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    const failure = { ok: false, scenario: scenario.name, error: message };
    summaries.push(failure);
    console.error(JSON.stringify(failure));
  }
}

const aggregate = {
  ok: !failed,
  total: summaries.length,
  passed: summaries.filter((s) => s.ok).length,
  failed: summaries.filter((s) => !s.ok).length,
};
console.log(JSON.stringify({ aggregate }));
process.exit(failed ? 1 : 0);
