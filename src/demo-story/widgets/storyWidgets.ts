import { requireCatalogLayer } from "../../catalog";
import type { StoryRegistry, StoryWidgetContext } from "../runtime";
import { ARCTIC_POINT, MAYOTTE_POINT } from "../scenes";
import ensoJson from "../data/enso.json";
import chidoTrackJson from "../data/chido-track.json";
import type { EnsoStoryData } from "../types";
import { renderArcticChart, renderChartStatus, renderEnsoChart, renderMayotteChart } from "../charts/StoryCharts";
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

function widgetShell(host: HTMLElement): { chart: HTMLElement; provenance: HTMLElement } {
  const chart = document.createElement("div");
  chart.className = "chart";
  const provenance = document.createElement("footer");
  provenance.className = "provenance";
  host.replaceChildren(chart, provenance);
  return { chart, provenance };
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(ms));
}

export function registerStoryWidgets(registry: StoryRegistry): void {
  registry.registerWidgetType("arctic-series", async (host, config, context) => {
    const { chart, provenance } = widgetShell(host);
    const view = requiredView(config, context);
    view.setArcticMeasurementPoint();
    renderChartStatus(chart, "Loading measurements…");
    const result = await view.zartigl.queryTimeSeries({ longitude: ARCTIC_POINT.longitude, latitude: ARCTIC_POINT.latitude, maxPoints: 420 });
    if (context.signal.aborted) return;
    view.setArcticMeasurementPoint({ longitude: result.longitude, latitude: result.latitude });
    const controller = renderArcticChart(chart, result, "sithick", view.zartigl.getVariableMeta().units ?? "m", chartOptions(config, context));
    context.setTimeCursor(controller.setCursor);
    provenance.textContent = `${requireCatalogLayer("sea-ice-thickness").dataset.id} · nearest grid point ${result.latitude.toFixed(3)}°, ${result.longitude.toFixed(3)}° · ${result.points.length} samples`;
    return () => controller.destroy();
  });
  registry.registerWidgetType("enso-series", (host, config, context) => {
    if (context.signal.aborted) return;
    const { chart, provenance } = widgetShell(host);
    const data = ensoJson as EnsoStoryData;
    const controller = renderEnsoChart(chart, data, chartOptions(config, context));
    context.setTimeCursor(controller.setCursor);
    provenance.textContent = `Area-weighted native-grid means · ${data.source.datasetId} · generated ${formatTime(Date.parse(data.generatedAt))}`;
    return () => controller.destroy();
  });
  registry.registerWidgetType("mayotte-wind", async (host, config, context) => {
    const { chart, provenance } = widgetShell(host);
    const view = requiredView(config, context);
    renderChartStatus(chart, "Loading measurements…");
    const result = await view.zartigl.queryTimeSeries({ longitude: MAYOTTE_POINT.longitude, latitude: MAYOTTE_POINT.latitude, maxPoints: 180 });
    if (context.signal.aborted) return;
    const controller = renderMayotteChart(chart, result, chartOptions(config, context));
    context.setTimeCursor(controller.setCursor);
    provenance.textContent = `Hourly sea-surface wind (not station gust): ${requireCatalogLayer("surface-wind").dataset.id} · nearest grid point ${result.latitude.toFixed(4)}°, ${result.longitude.toFixed(4)}° · Track: ${chidoTrackJson.source.name} ${chidoTrackJson.source.version}`;
    return () => controller.destroy();
  });
}
