import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@safecache/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@safecache/memory": fileURLToPath(new URL("../memory/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
