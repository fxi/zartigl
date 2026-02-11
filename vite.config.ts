import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl/",
  root: "src/demo",
  publicDir: "../../public",
  build: {
    outDir: "../../dist-demo",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      zartigl: "/src/lib",
    },
  },
});
