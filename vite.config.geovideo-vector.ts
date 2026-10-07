import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

// Local lab: assets come from `uv run scripts/geovideo/vector_lab.py export <dataset>`.
export default defineConfig({
  plugins: [glsl()],
  base: "/",
  root: "src/demo-geovideo-vector",
  publicDir: "../../artifacts/geovideo-vector",
  envDir: "../..",
  envPrefix: ["VITE_", "MAPTILER_", "PROTOMAPS_"],
});
