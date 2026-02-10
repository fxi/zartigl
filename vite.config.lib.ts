import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  build: {
    lib: {
      entry: "src/lib/index.ts",
      name: "zartigl",
      formats: ["es"],
      fileName: "zartigl",
    },
    rollupOptions: {
      external: ["maplibre-gl"],
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
