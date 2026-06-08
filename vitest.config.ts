import { defineConfig } from "vitest/config";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
