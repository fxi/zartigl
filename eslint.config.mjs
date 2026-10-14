import globals from "globals";
import style from "./quality/style.config.mjs";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...style,
  {
    files: ["src/**/*.{js,jsx,ts,tsx}", "packages/*/src/**/*.{js,ts}"],
    languageOptions: { globals: globals.browser },
  },
  {
    // projversor will move to its own repository and consume zartigl only
    // through its published entry points.
    files: ["src/demo-projection/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../lib/*", "../catalog/*", "../demo-*/*", "../mapx/*"],
              message: "Import zartigl through ../engine or ../catalog only.",
            },
          ],
        },
      ],
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
