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
        engine: "src/engine.ts",
        story: "src/story/index.ts",
      },
      name: "zartigl",
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // Dependencies stay imports, installed and bundled once by the host;
      // webpack 4 hosts alias numcodecs/blosc, which only has "exports".
      external: [/^maplibre-gl/, /^numcodecs(?:\/|$)/, /^pako(?:\/|$)/],
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
