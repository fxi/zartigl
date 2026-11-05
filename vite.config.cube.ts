import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl/cube/",
  root: "src/cube",
  publicDir: false,
  build: {
    outDir: "../../dist-cube",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
