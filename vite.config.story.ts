import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl/story/",
  root: "src/demo-story",
  publicDir: false,
  envDir: "../..",
  envPrefix: ["VITE_", "MAPTILER_", "PROTOMAPS_"],
  build: {
    outDir: "../../dist-story",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
