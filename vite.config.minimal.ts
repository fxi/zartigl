import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl/",
  root: "src/demo-minimal",
  publicDir: false,
  envDir: "../..",
  envPrefix: ["VITE_", "MAPTILER_", "PROTOMAPS_"],
  build: {
    outDir: "../../dist-demo-minimal",
    emptyOutDir: true,
  },
});
