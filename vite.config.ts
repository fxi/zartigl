import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
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
