import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [glsl(), dts({ include: ["src"], rollupTypes: true })],
  publicDir: false,
  build: {
    lib: {
      entry: {
        zartigl: "src/index.ts",
        catalog: "src/catalog/index.ts",
      },
      name: "zartigl",
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ["maplibre-gl"],
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
