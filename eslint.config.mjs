import globals from "globals";
import style from "./quality/style.config.mjs";

// zartigl never imports projversor: projversor is a client of the engine,
// catalog and story entries. ESLint replaces a rule's options per block, so
// the story block below repeats this pattern.
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
            NO_PROJVERSOR,
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
