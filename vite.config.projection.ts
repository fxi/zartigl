import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

// Standalone projection demo: GeoVideo currents on a reprojectable sphere.
export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl/projversor/",
  root: "src/demo-projection",
  publicDir: false,
  build: {
    outDir: "../../dist-projection",
    emptyOutDir: true,
  },
});
