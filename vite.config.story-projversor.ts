import { resolve } from "node:path";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

// Projversor story: scenes morphing one projversor sphere, plus its layout
// contact sheet (sheet.html).
const root = resolve(import.meta.dirname, "src/demo-story-projversor");

export default defineConfig({
  plugins: [glsl()],
  base: "/zartigl/projversor/story/",
  root,
  publicDir: false,
  build: {
    outDir: "../../dist-story-projversor",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        sheet: resolve(root, "sheet.html"),
      },
    },
  },
});
