import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl/",
  root: "src/demo-prod",
  publicDir: false,
  envDir: "../..",
  envPrefix: ["VITE_", "MAPTILER_", "PROTOMAPS_"],
  build: {
    outDir: "../../dist-demo",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
