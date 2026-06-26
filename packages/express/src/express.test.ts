import { describe, expect, test } from "vitest";
import { createCache } from "@safecache/core";
import { safeCacheMiddleware, type SafeCacheRequest } from "./index";

describe("safeCacheMiddleware", () => {
  test("attaches cache to request and calls next", () => {
    const cache = createCache({
      namespace: "express",
      provider: {
        name: "noop",
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      defaultTtl: "1m",
    });
    const req: SafeCacheRequest = {};
    let called = false;

    safeCacheMiddleware(cache)(req, {}, () => {
      called = true;
    });

    expect(req.safeCache).toBe(cache);
    expect(called).toBe(true);
  });
});
