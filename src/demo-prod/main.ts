import maplibregl from "maplibre-gl";
import { catalog } from "../catalog";
import { DemoApp } from "./DemoApp";

const map = new maplibregl.Map({
  container: "map",
  style: `https://api.maptiler.com/maps/satellite-v4/style.json?key=${import.meta.env.MAPTILER_TOKEN}`,
  center: [0, 20],
  zoom: 2,
  maxZoom: 8,
});

map.on("load", () => {
  const app = new DemoApp(map, catalog);
  (window as Window & { app?: DemoApp }).app = app;
});
