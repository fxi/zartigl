import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [glsl(), dts({ include: ["src/lib"], rollupTypes: true })],
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
