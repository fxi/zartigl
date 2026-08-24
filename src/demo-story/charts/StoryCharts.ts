import * as d3 from "d3";
import type { ZarrPointSeriesResult } from "../../lib";
import { ENSO_REGION_COLORS } from "../scenes";
import type { EnsoStoryData } from "../types";

type Datum = { time: number; value: number };
type Series = { id: string; label: string; color: string; values: Datum[] };

export interface StoryChartController {
  setCursor(time: number): void;
  destroy(): void;
}

export interface StoryChartOptions {
  interactiveTime?: boolean;
  compact?: boolean;
  directLabels?: boolean;
  onStart?(): void;
  onSeek?(time: number): void;
  onEnd?(): void;
}

const COLORS = ["#e995ff", "#67d9ff", "#ffbf69", "#75e39a"];

export function spreadChartLabels(values: readonly number[], min: number, max: number, gap: number): number[] {
  if (!values.length) return [];
  const effectiveGap = values.length > 1 ? Math.min(gap, (max - min) / (values.length - 1)) : 0;
  const indexed = values.map((value, index) => ({ value: Math.max(min, Math.min(max, value)), index }))
    .sort((a, b) => a.value - b.value);
  for (let index = 1; index < indexed.length; index += 1) {
    indexed[index].value = Math.max(indexed[index].value, indexed[index - 1].value + effectiveGap);
  }
  indexed[indexed.length - 1].value = Math.min(max, indexed[indexed.length - 1].value);
  for (let index = indexed.length - 2; index >= 0; index -= 1) {
    indexed[index].value = Math.min(indexed[index].value, indexed[index + 1].value - effectiveGap);
  }
  indexed[0].value = Math.max(min, indexed[0].value);
  for (let index = 1; index < indexed.length; index += 1) {
    indexed[index].value = Math.max(indexed[index].value, indexed[index - 1].value + effectiveGap);
  }
  const result = new Array<number>(values.length);
  for (const entry of indexed) result[entry.index] = entry.value;
  return result;
}

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

export function nearestChartTime(times: readonly number[], target: number): number | undefined {
  if (times.length === 0 || !Number.isFinite(target)) return undefined;
  if (target <= times[0]) return times[0];
  const last = times.length - 1;
  if (target >= times[last]) return times[last];
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle] <= target) low = middle;
    else high = middle;
  }
  return target - times[low] <= times[high] - target ? times[low] : times[high];
}

function lineChart(host: HTMLElement, series: Series[], unit: string, options: StoryChartOptions = {}): StoryChartController {
  clear(host);
  series = series.filter((entry) => entry.values.length > 0);
  const all = series.flatMap((entry) => entry.values);
  if (!all.length) {
    status(host, "No samples available in this snapshot.");
    return { setCursor: () => undefined, destroy: () => undefined };
  }

  const compact = options.compact === true;
  const directLabels = options.directLabels === true;
  const width = 680;
  const height = compact ? 210 : 250;
  const margin = compact
    ? { top: 18, right: directLabels ? 92 : 18, bottom: 32, left: 44 }
    : { top: 20, right: 22, bottom: 36, left: 52 };
  host.dataset.density = compact ? "compact" : "standard";
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
    .call(d3.axisLeft(y).ticks(compact ? 4 : 5).tickSize(-(width - margin.left - margin.right)).tickFormat(() => ""));
  svg.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(compact ? 4 : 5).tickSizeOuter(0));
  svg.append("g")
    .attr("class", "chart-axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(compact ? 4 : 5));
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

  if (directLabels) {
    const finalPoints = series.map((entry) => entry.values[entry.values.length - 1]);
    const labelY = spreadChartLabels(
      finalPoints.map((point) => y(point.value)),
      margin.top + 7,
      height - margin.bottom - 7,
      15,
    );
    series.forEach((entry, index) => {
      svg.append("line")
        .attr("class", "chart-end-leader")
        .attr("x1", x(finalPoints[index].time) + 4)
        .attr("x2", width - margin.right + 6)
        .attr("y1", y(finalPoints[index].value))
        .attr("y2", labelY[index])
        .attr("stroke", entry.color);
      svg.append("text")
        .attr("class", "chart-end-label")
        .attr("x", width - margin.right + 10)
        .attr("y", labelY[index])
        .attr("fill", entry.color)
        .attr("dominant-baseline", "middle")
        .text(entry.label);
    });
  }

  const legend = d3.select(host).append("div").attr("class", "chart-legend");
  if (directLabels) legend.attr("hidden", "");
  for (const entry of series) {
    const item = legend.append("span");
    item.append("i").style("background", entry.color);
    item.append("span").text(entry.label);
  }

  const cursor = svg.append("g").attr("class", "chart-cursor").style("display", "none");
  cursor.append("line").attr("y1", margin.top).attr("y2", height - margin.bottom);
  cursor.append("text").attr("y", margin.top + 12);

  let cursorTime: number | null = null;
  const setCursor = (time: number): void => {
    if (!Number.isFinite(time)) return;
    const clamped = Math.max(x.domain()[0].getTime(), Math.min(x.domain()[1].getTime(), time));
    cursorTime = clamped;
    cursor.style("display", null).attr("transform", `translate(${x(clamped)},0)`);
    cursor.select("text")
      .attr("x", x(clamped) > width * 0.7 ? -8 : 8)
      .attr("text-anchor", x(clamped) > width * 0.7 ? "end" : "start")
      .text(d3.utcFormat("%d %b %Y %H:%M")(new Date(clamped)));
    hitArea?.setAttribute("aria-valuenow", String(clamped));
    hitArea?.setAttribute("aria-valuetext", d3.utcFormat("%d %b %Y %H:%M UTC")(new Date(clamped)));
  };

  let hitArea: SVGRectElement | null = null;
  let destroy = (): void => undefined;
  if (options.interactiveTime) {
    const times = [...new Set(all.map((datum) => datum.time))].sort((a, b) => a - b);
    hitArea = svg.append("rect")
      .attr("class", "chart-hit-area")
      .attr("x", margin.left)
      .attr("y", margin.top)
      .attr("width", width - margin.left - margin.right)
      .attr("height", height - margin.top - margin.bottom)
      .attr("fill", "transparent")
      .attr("role", "slider")
      .attr("tabindex", 0)
      .attr("aria-label", "Time")
      .attr("aria-orientation", "horizontal")
      .attr("aria-valuemin", String(times[0]))
      .attr("aria-valuemax", String(times[times.length - 1]))
      .node();

    let pointerId: number | null = null;
    const seekAt = (event: PointerEvent): void => {
      if (!hitArea) return;
      const bounds = hitArea.ownerSVGElement!.getBoundingClientRect();
      const localX = bounds.width > 0 ? (event.clientX - bounds.left) * width / bounds.width : margin.left;
      const requested = x.invert(Math.max(margin.left, Math.min(width - margin.right, localX))).getTime();
      const snapped = nearestChartTime(times, requested);
      if (snapped === undefined) return;
      setCursor(snapped);
      options.onSeek?.(snapped);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (pointerId !== null || event.button !== 0) return;
      pointerId = event.pointerId;
      hitArea?.setPointerCapture?.(pointerId);
      options.onStart?.();
      seekAt(event);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId === pointerId) seekAt(event);
    };
    const finishPointer = (event: PointerEvent, seek: boolean): void => {
      if (event.pointerId !== pointerId) return;
      if (seek) seekAt(event);
      const completed = pointerId;
      pointerId = null;
      if (completed !== null && hitArea?.hasPointerCapture?.(completed)) hitArea.releasePointerCapture(completed);
      options.onEnd?.();
    };
    const onPointerUp = (event: PointerEvent): void => finishPointer(event, true);
    const onPointerCancel = (event: PointerEvent): void => finishPointer(event, false);
    const onLostPointerCapture = (event: PointerEvent): void => finishPointer(event, false);
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = nearestChartTime(times, cursorTime ?? times[0]) ?? times[0];
      const currentIndex = Math.max(0, times.indexOf(current));
      let nextIndex: number | null = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextIndex = Math.max(0, currentIndex - 1);
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") nextIndex = Math.min(times.length - 1, currentIndex + 1);
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = times.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      const time = times[nextIndex];
      options.onStart?.();
      setCursor(time);
      options.onSeek?.(time);
      options.onEnd?.();
    };
    hitArea?.addEventListener("pointerdown", onPointerDown);
    hitArea?.addEventListener("pointermove", onPointerMove);
    hitArea?.addEventListener("pointerup", onPointerUp);
    hitArea?.addEventListener("pointercancel", onPointerCancel);
    hitArea?.addEventListener("lostpointercapture", onLostPointerCapture);
    hitArea?.addEventListener("keydown", onKeyDown);
    destroy = () => {
      hitArea?.removeEventListener("pointerdown", onPointerDown);
      hitArea?.removeEventListener("pointermove", onPointerMove);
      hitArea?.removeEventListener("pointerup", onPointerUp);
      hitArea?.removeEventListener("pointercancel", onPointerCancel);
      hitArea?.removeEventListener("lostpointercapture", onLostPointerCapture);
      hitArea?.removeEventListener("keydown", onKeyDown);
      pointerId = null;
    };
  }

  return { setCursor, destroy };
}

export function renderArcticChart(host: HTMLElement, result: ZarrPointSeriesResult, variable: string, unit: string, options?: StoryChartOptions): StoryChartController {
  const values = result.points
    .map((point) => ({ time: point.time ?? point.axisValue, value: point.values[variable] }))
    .filter((point): point is Datum => valid(point.time) && valid(point.value));
  return lineChart(host, [{ id: "ice", label: "Sea-ice thickness", color: COLORS[1], values }], unit, options);
}

export function renderEnsoChart(host: HTMLElement, data: EnsoStoryData, options?: StoryChartOptions): StoryChartController {
  const series = data.regions.map((region, index) => ({
    id: region.id,
    label: region.label,
    color: ENSO_REGION_COLORS[region.id] ?? COLORS[index % COLORS.length],
    values: region.points
      .filter((point) => valid(point.mean))
      .map((point) => ({ time: Date.parse(point.time), value: point.mean! })),
  }));
  return lineChart(host, series, data.source.unit, options);
}

export function renderMayotteChart(
  host: HTMLElement,
  wind: ZarrPointSeriesResult,
  options?: StoryChartOptions,
): StoryChartController {
  const windValues = wind.points.map((point) => {
    const u = point.values.eastward_wind;
    const v = point.values.northward_wind;
    return { time: point.time ?? point.axisValue, value: Math.hypot(u, v) };
  }).filter((point): point is Datum => valid(point.time) && valid(point.value));
  return lineChart(host, [
    { id: "wind", label: "Wind speed", color: COLORS[1], values: windValues },
  ], "m s⁻¹", options);
}

export function renderChartStatus(host: HTMLElement, message: string): void {
  status(host, message);
}
