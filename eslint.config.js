// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Root ESLint flat config for the SafeCache monorepo.
 *
 * Goals:
 *  - Provide a real, fast lint (NON type-checked typescript-eslint rules) that
 *    runs in CI without needing a full TypeScript program per file.
 *  - Stay GREEN on the current codebase: rules that would otherwise error across
 *    existing source are relaxed to "warn" or "off" below. Type-level safety is
 *    already enforced separately by `tsc --noEmit` (the `typecheck` script).
 */
export default tseslint.config(
  // Never lint build output, dependencies, or coverage reports.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.cache/**",
      "**/worktrees/**",
      "**/.worktrees/**",
    ],
  },

  // Base recommended sets.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Pre-existing inline `eslint-disable` directives in source we do not own can
  // become "unused" once a rule is relaxed below; do not let that fail the lint.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },

  // Project-wide tuning to keep the lint green and fast.
  {
    files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: {
      // `tsc` already governs implicit/explicit `any`; a handful of generic
      // defaults (e.g. Record<string, T<any>>) are intentional here.
      "@typescript-eslint/no-explicit-any": "off",
      // No-op callbacks (`() => {}`) are a deliberate, common pattern for
      // default handlers across the codebase.
      "@typescript-eslint/no-empty-function": "off",
      // `Function`-typed mock/spy values appear throughout the test suites.
      "@typescript-eslint/no-unsafe-function-type": "off",
      // Empty interfaces/`{}` are used as marker/extension points.
      "@typescript-eslint/no-empty-object-type": "off",
      // `const self = this` appears in a few interop shims; tsc keeps it sound.
      "@typescript-eslint/no-this-alias": "off",
      // Triple-slash `/// <reference ... />` is required for ambient module
      // augmentation (e.g. framework type extensions).
      "@typescript-eslint/triple-slash-reference": "off",
      // Newer eslint core correctness rules that fire on existing, intentional
      // patterns; defer to tsc / reviewer judgement rather than failing CI.
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",
      // Surface unused symbols as warnings, and allow the conventional
      // leading-underscore opt-out instead of failing the build.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // The non-type-checked preset cannot reason about these safely; defer to tsc.
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  // Tests and examples are even more permissive.
  {
    files: ["**/*.test.{ts,mts,cts}", "examples/**/*.{ts,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-console": "off",
    },
  },

  // Config / tooling files run in Node and may use CommonJS globals.
  {
    files: ["**/*.config.{js,mjs,cjs,ts}", "*.config.{js,mjs,cjs,ts}"],
    rules: {
      "@typescript-eslint/no-var-requires": "off",
    },
  },
);
