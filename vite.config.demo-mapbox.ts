import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl-mapbox/",
  root: "src/demo-mapbox",
  publicDir: "../../public",
  envDir: "../..",
  envPrefix: ["VITE_", "MAPBOX_"],
  build: {
    outDir: "../../dist-demo-mapbox",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      zartigl: "/src/lib",
    },
  },
});
