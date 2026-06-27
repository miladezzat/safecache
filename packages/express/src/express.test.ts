import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { Cache } from "@safecache/core";
import { createCache } from "@safecache/core";
import {
  safeCacheMiddleware,
  type ExpressMiddleware,
  type SafeCacheMiddlewareOptions,
  type SafeCacheRequest,
} from "./index";

function makeCache(overrides: Partial<Parameters<typeof createCache>[0]["provider"]> = {}): Cache {
  return createCache({
    namespace: "express",
    provider: {
      name: "noop",
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      ...overrides,
    },
    defaultTtl: "1m",
  });
}

describe("safeCacheMiddleware", () => {
  test("attaches cache to request and calls next with no error", () => {
    const cache = makeCache();
    const req: SafeCacheRequest = {};
    const next = vi.fn();

    safeCacheMiddleware(cache)(req, {}, next);

    expect(req.safeCache).toBe(cache);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test("the attached cache is usable from the handler (end-to-end query)", async () => {
    const cache = makeCache({ get: async () => null });
    const req: SafeCacheRequest = {};
    safeCacheMiddleware(cache)(req, {}, () => {});

    // Simulate a route handler reading through the request-scoped cache.
    const value = await req.safeCache?.query({
      key: "user:1",
      fetcher: async () => ({ id: "1", name: "Ada" }),
    });

    expect(value).toEqual({ id: "1", name: "Ada" });
  });

  test("returns a fresh middleware instance per call", () => {
    const cache = makeCache();
    const a = safeCacheMiddleware(cache);
    const b = safeCacheMiddleware(cache);
    expect(a).not.toBe(b);
  });
});

describe("safeCacheMiddleware — fail-open safety", () => {
  // A request whose `safeCache` property cannot be assigned (frozen / sealed /
  // throwing setter) models a cache-side failure in the middleware hot path.
  function makeUnassignableRequest(): SafeCacheRequest {
    const req = {};
    Object.defineProperty(req, "safeCache", {
      configurable: false,
      enumerable: true,
      get: () => undefined,
      set: () => {
        throw new Error("boom: cannot attach cache");
      },
    });
    return req as SafeCacheRequest;
  }

  test("a cache-side failure does NOT throw into the Express pipeline", () => {
    const cache = makeCache();
    const req = makeUnassignableRequest();
    const next = vi.fn();

    // The middleware itself must not throw, regardless of the attach failing.
    expect(() => safeCacheMiddleware(cache)(req, {}, next)).not.toThrow();
  });

  test("on a cache-side failure, next() is still called with no error", () => {
    const cache = makeCache();
    const req = makeUnassignableRequest();
    const next = vi.fn();

    safeCacheMiddleware(cache)(req, {}, next);

    expect(next).toHaveBeenCalledTimes(1);
    // Crucially: next() is called WITHOUT an error — the cache failure is never
    // surfaced to Express error-handling middleware.
    expect(next).toHaveBeenCalledWith();
  });

  test("a cache-side failure is routed to the onError notifier", () => {
    const cache = makeCache();
    const req = makeUnassignableRequest();
    const onError = vi.fn<NonNullable<SafeCacheMiddlewareOptions["onError"]>>();

    safeCacheMiddleware(cache, { onError })(req, {}, () => {});

    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported?.message).toContain("boom: cannot attach cache");
  });

  test("the host operation continues as if the cache were absent", async () => {
    const cache = makeCache();
    const req = makeUnassignableRequest();
    let handlerRan = false;
    let observedCache: Cache | undefined = cache;

    // Minimal Express-like pipeline: middleware then a route handler.
    safeCacheMiddleware(cache)(req, {}, () => {
      handlerRan = true;
      observedCache = req.safeCache; // undefined because attach failed
    });

    expect(handlerRan).toBe(true);
    expect(observedCache).toBeUndefined();

    // The handler can still do its real work without the cache present.
    const result = observedCache
      ? await observedCache.query({ key: "x", fetcher: async () => "cached" })
      : await Promise.resolve("from-source");
    expect(result).toBe("from-source");
  });

  test("a throwing onError notifier never breaks the middleware", () => {
    const cache = makeCache();
    const req = makeUnassignableRequest();
    const next = vi.fn();
    const onError = () => {
      throw new Error("notifier exploded");
    };

    expect(() => safeCacheMiddleware(cache, { onError })(req, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test("defaults to a silent no-op notifier (no throw, no console)", () => {
    const cache = makeCache();
    const req = makeUnassignableRequest();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => safeCacheMiddleware(cache)(req, {}, () => {})).not.toThrow();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe("safeCacheMiddleware — types", () => {
  test("req.safeCache is usable without casting (augmented Express Request)", () => {
    const cache = makeCache();
    const req: SafeCacheRequest = {};
    safeCacheMiddleware(cache)(req, {}, () => {});

    // No cast needed: `safeCache` is an optional Cache on the request shape.
    expectTypeOf(req.safeCache).toEqualTypeOf<Cache | undefined>();
  });

  test("middleware is generic over the request type", () => {
    interface AppRequest extends SafeCacheRequest {
      userId: string;
    }
    const cache = makeCache();
    const mw = safeCacheMiddleware<AppRequest>(cache);
    expectTypeOf(mw).toMatchTypeOf<ExpressMiddleware<AppRequest>>();
  });

  test("onError option is typed as (error: Error) => void", () => {
    expectTypeOf<NonNullable<SafeCacheMiddlewareOptions["onError"]>>().toEqualTypeOf<
      (error: Error) => void
    >();
  });
});
