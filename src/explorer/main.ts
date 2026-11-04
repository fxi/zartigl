import maplibregl from "maplibre-gl";
import { catalog as bundled, loadCatalog } from "../catalog";
import { DemoApp } from "./DemoApp";

const map = new maplibregl.Map({
  container: "map",
  style: `https://api.maptiler.com/maps/satellite-v4/style.json?key=${
    import.meta.env.MAPTILER_TOKEN
  }`,
  center: [0, 20],
  zoom: 2,
  // Regional stores reach 30 m (Landsat around Malé): zoom 15 is about 5 m per pixel.
  maxZoom: 15,
});

// The deployed explorer reads the live catalog, as MapX does: it carries the
// producer-declared coverage of each store. Development shows local edits.
const catalog = import.meta.env.DEV
  ? Promise.resolve(bundled)
  : loadCatalog().then((loaded) => loaded.catalog);

map.on("load", () => {
  void catalog.then((loaded) => {
    const app = new DemoApp(map, loaded);
    (window as Window & { app?: DemoApp }).app = app;
  });
});
