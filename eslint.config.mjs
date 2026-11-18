import globals from "globals";
import style from "./quality/style.config.mjs";

// zartigl never imports projversor: projversor is a client of the engine and
// catalog entries. The story format lives in @fxi/story (../story).
const NO_PROJVERSOR = {
  group: ["@fxi/projversor", "@fxi/projversor/*"],
  message: "zartigl never imports projversor; projversor depends on zartigl.",
};

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...style,
  {
    files: ["src/**/*.{js,jsx,ts,tsx}", "packages/*/src/**/*.{js,ts}"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_PROJVERSOR] }],
    },
  },
  {
    files: [
      "*.{js,mjs,cjs,ts}",
      "quality/**/*.mjs",
      "scripts/**/*.{js,mjs,cjs,ts}",
      "tests/**/*.{js,ts}",
    ],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  {
    files: ["**/*.{cjs,cts}"],
    languageOptions: { globals: globals.node },
  },
];
