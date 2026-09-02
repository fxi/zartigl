import { findCatalogEntries } from "../../catalog";
import type { StoryRegistry, StoryWidgetContext } from "../runtime";
import { resolveLocalizedText } from "../runtime";
import { ARCTIC_POINT, MAYOTTE_POINT } from "../scenes";
import ensoJson from "../data/enso.json";
import balticHypoxiaJson from "../data/baltic-hypoxia.json";
import chidoTrackJson from "../data/chido-track.json";
import type { BalticHypoxiaStoryData, EnsoStoryData } from "../types";
import { renderArcticChart, renderBalticHypoxiaChart, renderChartStatus, renderEnsoChart, renderMayotteChart } from "../charts/StoryCharts";
import { ZartiglStoryView } from "../adapters/ZartiglStoryView";

function chartOptions(config: Record<string, unknown>, context: StoryWidgetContext) {
  const compact = matchMedia("(max-width: 850px)").matches;
  return {
    interactiveTime: config.interactiveTime === true,
    compact,
    directLabels: compact,
    onStart: () => context.beginTimeInteraction(),
    onSeek: (time: number) => context.requestTime(time),
    onEnd: () => context.endTimeInteraction(),
  };
}

function requiredView(config: Record<string, unknown>, context: StoryWidgetContext): ZartiglStoryView {
  const viewId = config.view;
  if (typeof viewId !== "string") throw new Error("Widget config.view is required");
  const adapter = context.getViewAdapter(viewId);
  if (!(adapter instanceof ZartiglStoryView)) throw new Error(`Widget requires an active Zartigl view: ${viewId}`);
  return adapter;
}

function widgetShell(host: HTMLElement, context: StoryWidgetContext): { chart: HTMLElement; provenance: HTMLElement } {
  const chart = document.createElement("div");
  chart.className = "chart";
  const caption = document.createElement("p");
  caption.className = "widget-caption";
  caption.textContent = context.block.caption
    ? resolveLocalizedText(context.block.caption, context.locale, "en", ["en"])
    : "";
  caption.hidden = !caption.textContent;
  const provenance = document.createElement("footer");
  provenance.className = "provenance";
  host.replaceChildren(chart, caption, provenance);
  return { chart, provenance };
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(ms));
}

function datasetForVariable(variableId: string): string {
  const entry = findCatalogEntries({ variableId })[0];
  const source = entry?.sources.find((candidate) => candidate.type === "zarr");
  return source?.provenance?.identifiers?.dataset ?? "unknown dataset";
}

export function registerStoryWidgets(registry: StoryRegistry): void {
  registry.registerWidgetType("arctic-series", async (host, config, context) => {
    const { chart, provenance } = widgetShell(host, context);
    const view = requiredView(config, context);
    view.setArcticMeasurementPoint();
    renderChartStatus(chart, "Loading measurements…");
    const result = await view.zartigl.queryTimeSeries({ longitude: ARCTIC_POINT.longitude, latitude: ARCTIC_POINT.latitude, maxPoints: 420 });
    if (context.signal.aborted) return;
    view.setArcticMeasurementPoint({ longitude: result.longitude, latitude: result.latitude });
    const controller = renderArcticChart(chart, result, "sithick", view.zartigl.getVariableMeta().units ?? "m", chartOptions(config, context));
    context.setTimeCursor(controller.setCursor);
    provenance.textContent = `${datasetForVariable("sithick")} · nearest grid point ${result.latitude.toFixed(3)}°, ${result.longitude.toFixed(3)}° · ${result.points.length} samples`;
    return () => controller.destroy();
  });
  registry.registerWidgetType("enso-series", (host, config, context) => {
    if (context.signal.aborted) return;
    const { chart, provenance } = widgetShell(host, context);
    const data = ensoJson as EnsoStoryData;
    const controller = renderEnsoChart(chart, data, chartOptions(config, context));
    context.setTimeCursor(controller.setCursor);
    provenance.textContent = `Area-weighted native-grid means · ${data.source.datasetId} · generated ${formatTime(Date.parse(data.generatedAt))}`;
    return () => controller.destroy();
  });
  registry.registerWidgetType("baltic-hypoxia", (host, config, context) => {
    if (context.signal.aborted) return;
    const { chart, provenance } = widgetShell(host, context);
    const data = balticHypoxiaJson as BalticHypoxiaStoryData;
    const controller = renderBalticHypoxiaChart(chart, data, chartOptions(config, context), context.locale);
    context.setTimeCursor(controller.setCursor);
    const limitation = context.locale.startsWith("fr")
      ? "réanalyse modélisée; l’O₂ profond peut être surestimé"
      : "model reanalysis; deep O₂ may be overestimated";
    provenance.append(`${data.source.datasetId} · ${limitation} · `);
    data.references.forEach((reference, index) => {
      const link = document.createElement("a");
      link.href = reference.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = reference.label;
      provenance.append(link);
      if (index < data.references.length - 1) provenance.append(" · ");
    });
    return () => controller.destroy();
  });
  registry.registerWidgetType("mayotte-wind", async (host, config, context) => {
    const { chart, provenance } = widgetShell(host, context);
    const view = requiredView(config, context);
    renderChartStatus(chart, "Loading measurements…");
    const result = await view.zartigl.queryTimeSeries({ longitude: MAYOTTE_POINT.longitude, latitude: MAYOTTE_POINT.latitude, maxPoints: 180 });
    if (context.signal.aborted) return;
    const controller = renderMayotteChart(chart, result, chartOptions(config, context));
    context.setTimeCursor(controller.setCursor);
    provenance.textContent = `Hourly sea-surface wind (not station gust): ${datasetForVariable("eastward_wind")} · nearest grid point ${result.latitude.toFixed(4)}°, ${result.longitude.toFixed(4)}° · Track: ${chidoTrackJson.source.name} ${chidoTrackJson.source.version}`;
    return () => controller.destroy();
  });
}
