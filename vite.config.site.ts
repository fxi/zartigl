import { resolve } from "node:path";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

// Home page prototype: a scroll story framed by a header and a footer, all
// from public/content/home.json. Content stays outside the bundle, so the
// story of the month changes without a rebuild.
const root = resolve(import.meta.dirname, "src/demo-site");

export default defineConfig({
  plugins: [glsl()],
  base: "./",
  root,
  build: {
    outDir: "../../dist-site",
    emptyOutDir: true,
  },
});
