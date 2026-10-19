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
    // Modules are published as package entries: projversor reaches zartigl
    // through the engine and catalog entries only.
    files: ["src/projversor/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../lib",
                "../lib/*",
                "../catalog/*",
                "../demo-*",
                "../demo-*/*",
                "../mapx",
                "../mapx/*",
                "../story",
                "../story/*",
              ],
              message: "Import zartigl modules through their entry only.",
            },
          ],
        },
      ],
    },
  },
  {
    // The story runtime stands alone: no other zartigl module.
    files: ["src/story/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../*", "!../story", "!../story/*"],
              message: "The story runtime imports no other zartigl module.",
            },
          ],
        },
      ],
    },
  },
  {
    // The projversor apps consume zartigl only through package entries, so
    // they can move to their own repository.
    files: [
      "src/demo-projection/**/*.ts",
      "src/demo-story-projversor/**/*.ts",
      "src/demo-site/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../lib",
                "../lib/*",
                "../catalog/*",
                "../projversor/*",
                "../story/*",
                "../demo-*",
                "../demo-*/*",
                "../mapx",
                "../mapx/*",
                "../../lib",
                "../../lib/*",
                "../../catalog/*",
                "../../projversor/*",
                "../../story/*",
                "../../demo-*",
                "../../demo-*/*",
              ],
              message:
                "Import zartigl through ../engine, ../catalog, ../projversor or ../story only.",
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
