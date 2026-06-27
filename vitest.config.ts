import { defineConfig } from "vitest/config";

// Root config exists only so workspaces that ship no tests of their own (the
// examples under examples/*) pass cleanly instead of failing on "no test files".
// Every package under packages/* has its own vitest.config.ts, which takes
// precedence over this one.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
