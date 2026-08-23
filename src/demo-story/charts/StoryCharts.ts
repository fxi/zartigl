import * as d3 from "d3";
import type { ZarrPointSeriesResult } from "../../lib";
import { ENSO_REGION_COLORS } from "../scenes";
import type { EnsoStoryData } from "../types";

type Datum = { time: number; value: number };
type Series = { id: string; label: string; color: string; values: Datum[] };

const COLORS = ["#e995ff", "#67d9ff", "#ffbf69", "#75e39a"];

function valid(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clear(host: HTMLElement): void {
  host.replaceChildren();
  host.removeAttribute("data-empty");
}

function status(host: HTMLElement, message: string): void {
  clear(host);
  host.dataset.empty = "true";
  host.textContent = message;
}

function lineChart(host: HTMLElement, series: Series[], unit: string): (time: number) => void {
  clear(host);
  const all = series.flatMap((entry) => entry.values);
  if (!all.length) {
    status(host, "No samples available in this snapshot.");
    return () => undefined;
  }

  const width = 680;
  const height = 250;
  const margin = { top: 20, right: 22, bottom: 36, left: 52 };
  const x = d3.scaleUtc()
    .domain(d3.extent(all, (d) => d.time) as [number, number])
    .range([margin.left, width - margin.right]);
  const extent = d3.extent(all, (d) => d.value) as [number, number];
  const pad = Math.max((extent[1] - extent[0]) * 0.12, 0.1);
  const y = d3.scaleLinear()
    .domain([Math.min(0, extent[0] - pad), extent[1] + pad])
    .nice()
    .range([height - margin.bottom, margin.top]);

  const svg = d3.select(host).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", `Time series in ${unit}`);

  svg.append("g")
    .attr("class", "chart-grid")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(width - margin.left - margin.right)).tickFormat(() => ""));
  svg.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickSizeOuter(0));
  svg.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5));
  svg.append("text")
    .attr("class", "chart-unit")
    .attr("x", margin.left)
    .attr("y", 12)
    .text(unit);

  const makeLine = d3.line<Datum>()
    .x((d) => x(d.time))
    .y((d) => y(d.value));
  for (const entry of series) {
    svg.append("path")
      .datum(entry.values)
      .attr("class", "chart-line")
      .attr("stroke", entry.color)
      .attr("d", makeLine);
  }

  const legend = d3.select(host).append("div").attr("class", "chart-legend");
  for (const entry of series) {
    const item = legend.append("span");
    item.append("i").style("background", entry.color);
    item.append("span").text(entry.label);
  }

  const cursor = svg.append("g").attr("class", "chart-cursor").style("display", "none");
  cursor.append("line").attr("y1", margin.top).attr("y2", height - margin.bottom);
  cursor.append("text").attr("y", margin.top + 12);

  return (time: number) => {
    if (!Number.isFinite(time)) return;
    const clamped = Math.max(x.domain()[0].getTime(), Math.min(x.domain()[1].getTime(), time));
    cursor.style("display", null).attr("transform", `translate(${x(clamped)},0)`);
    cursor.select("text")
      .attr("x", x(clamped) > width * 0.7 ? -8 : 8)
      .attr("text-anchor", x(clamped) > width * 0.7 ? "end" : "start")
      .text(d3.utcFormat("%d %b %Y %H:%M")(new Date(clamped)));
  };
}

export function renderArcticChart(host: HTMLElement, result: ZarrPointSeriesResult, variable: string, unit: string): (time: number) => void {
  const values = result.points
    .map((point) => ({ time: point.time ?? point.axisValue, value: point.values[variable] }))
    .filter((point): point is Datum => valid(point.time) && valid(point.value));
  return lineChart(host, [{ id: "ice", label: "Sea-ice thickness", color: COLORS[1], values }], unit);
}

export function renderEnsoChart(host: HTMLElement, data: EnsoStoryData): (time: number) => void {
  const series = data.regions.map((region, index) => ({
    id: region.id,
    label: region.label,
    color: ENSO_REGION_COLORS[region.id] ?? COLORS[index % COLORS.length],
    values: region.points
      .filter((point) => valid(point.mean))
      .map((point) => ({ time: Date.parse(point.time), value: point.mean! })),
  }));
  return lineChart(host, series, data.source.unit);
}

export function renderMayotteChart(
  host: HTMLElement,
  wind: ZarrPointSeriesResult,
): (time: number) => void {
  const windValues = wind.points.map((point) => {
    const u = point.values.eastward_wind;
    const v = point.values.northward_wind;
    return { time: point.time ?? point.axisValue, value: Math.hypot(u, v) };
  }).filter((point): point is Datum => valid(point.time) && valid(point.value));
  return lineChart(host, [
    { id: "wind", label: "Wind speed", color: COLORS[1], values: windValues },
  ], "m s⁻¹");
}

export function renderChartStatus(host: HTMLElement, message: string): void {
  status(host, message);
}
