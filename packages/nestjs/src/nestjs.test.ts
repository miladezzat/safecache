import { describe, expect, test, vi } from "vitest";
import { createCache } from "@safecache/core";
import type { Cache, CacheProvider, QueryOptions } from "@safecache/core";
import { SAFE_CACHE, SafeCacheModule, SafeCacheService } from "./index";

/** A minimal no-op provider that never persists anything (always a cache miss). */
function noopProvider(): CacheProvider {
  return {
    name: "noop",
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
}

function makeCache(): Cache {
  return createCache({
    namespace: "nestjs",
    provider: noopProvider(),
    defaultTtl: "1m",
  });
}

/**
 * Resolve a SafeCacheDynamicModule's providers the way the NestJS DI container
 * would: each provider is built exactly once, and a `useFactory` provider
 * receives its already-resolved `inject` dependencies positionally.
 */
async function resolveProviders(
  module: ReturnType<typeof SafeCacheModule.forRoot>,
): Promise<Map<unknown, unknown>> {
  const resolved = new Map<unknown, unknown>();
  for (const provider of module.providers) {
    if (provider.useFactory) {
      const deps = (provider.inject ?? []).map((token) => resolved.get(token));
      resolved.set(provider.provide, await provider.useFactory(...(deps as never[])));
    } else {
      resolved.set(provider.provide, provider.useValue);
    }
  }
  return resolved;
}

describe("SafeCacheModule.forRoot", () => {
  test("wires SAFE_CACHE and SafeCacheService and exports both", () => {
    const cache = makeCache();
    const module = SafeCacheModule.forRoot({ cache });

    expect(module.module).toBe(SafeCacheModule);
    // Token provider carries the raw cache.
    expect(module.providers[0]?.provide).toBe(SAFE_CACHE);
    expect(module.providers[0]?.useValue).toBe(cache);
    // Service provider carries a SafeCacheService wrapping that same cache.
    expect(module.providers[1]?.provide).toBe(SafeCacheService);
    expect(module.providers[1]?.useValue).toBeInstanceOf(SafeCacheService);
    expect((module.providers[1]?.useValue as SafeCacheService).raw).toBe(cache);
    // Both symbols are exported so consumers can inject either one.
    expect(module.exports).toContain(SAFE_CACHE);
    expect(module.exports).toContain(SafeCacheService);
  });

  test("the injected cache is usable through the resolved service", async () => {
    const cache = makeCache();
    const module = SafeCacheModule.forRoot({ cache });
    const resolved = await resolveProviders(module);

    const service = resolved.get(SafeCacheService) as SafeCacheService;
    const tokenCache = resolved.get(SAFE_CACHE) as Cache;

    expect(service).toBeInstanceOf(SafeCacheService);
    expect(service.raw).toBe(tokenCache);
    // A real query flows through to the fetcher and returns its value.
    await expect(service.query({ key: "k", fetcher: async () => "v" })).resolves.toBe("v");
  });
});

describe("SafeCacheModule.forRootAsync", () => {
  test("runs the user factory exactly once and shares one cache instance", async () => {
    const cache = makeCache();
    let calls = 0;
    const module = SafeCacheModule.forRootAsync({
      useFactory: async () => {
        calls += 1;
        return cache;
      },
    });

    const resolved = await resolveProviders(module);
    const tokenCache = resolved.get(SAFE_CACHE);
    const service = resolved.get(SafeCacheService) as SafeCacheService;

    // Exactly one user factory run: no duplicate Cache instances / connections.
    expect(calls).toBe(1);
    expect(tokenCache).toBe(cache);
    expect(service).toBeInstanceOf(SafeCacheService);
    // SAFE_CACHE and SafeCacheService share the same underlying instance.
    expect(service.raw).toBe(cache);
    expect(service.raw).toBe(tokenCache);
  });

  test("the asynchronously-built cache is usable through the resolved service", async () => {
    const module = SafeCacheModule.forRootAsync({
      useFactory: async () => makeCache(),
    });
    const resolved = await resolveProviders(module);
    const service = resolved.get(SafeCacheService) as SafeCacheService;

    await expect(service.query({ key: "k", fetcher: async () => 42 })).resolves.toBe(42);
  });

  test("supports a synchronous factory", async () => {
    const cache = makeCache();
    const module = SafeCacheModule.forRootAsync({
      useFactory: () => cache,
    });
    const resolved = await resolveProviders(module);
    const service = resolved.get(SafeCacheService) as SafeCacheService;

    expect(service.raw).toBe(cache);
  });
});

describe("SafeCacheService", () => {
  test("delegates a successful query to the underlying cache", async () => {
    const service = new SafeCacheService(makeCache());
    await expect(service.query({ key: "k", fetcher: async () => "v" })).resolves.toBe("v");
  });

  test("a thrown CACHE-side error does NOT break the host operation", async () => {
    // A cache whose query() always throws as if the whole machinery were broken
    // (e.g. a misconfigured provider with fail-closed semantics). The adapter
    // must catch this, notify, and still return the fetcher's value.
    const onError = vi.fn();
    const explodingCache: Cache = {
      query: vi.fn(async () => {
        throw new Error("cache exploded");
      }),
    } as unknown as Cache;

    const service = new SafeCacheService(explodingCache, onError);

    // The host operation succeeds with the fetcher's result, despite the cache
    // throwing — the SafeCache safety guarantee.
    await expect(service.query({ key: "k", fetcher: async () => "from-origin" })).resolves.toBe(
      "from-origin",
    );

    // The cache-side failure was routed to the notifier, not swallowed silently.
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe("cache exploded");
  });

  test("normalizes a non-Error cache-side throw into an Error for the notifier", async () => {
    const onError = vi.fn();
    const explodingCache: Cache = {
      query: vi.fn(async () => {
        throw "string failure";
      }),
    } as unknown as Cache;

    const service = new SafeCacheService(explodingCache, onError);

    await expect(service.query({ key: "k", fetcher: async () => "ok" })).resolves.toBe("ok");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  test("does NOT swallow the user's own fetcher error", async () => {
    // When the fetcher (the user's own code) throws, that is NOT a cache-side
    // fault: it must propagate, and the fetcher must not be retried.
    const onError = vi.fn();
    const fetcher = vi.fn(async () => {
      throw new Error("DB is down");
    });
    const service = new SafeCacheService(makeCache(), onError);

    await expect(service.query({ key: "k", fetcher })).rejects.toThrow("DB is down");
    // The user's error is theirs to handle — the adapter neither swallows it
    // nor reports it as a cache-side error, and the fetcher runs exactly once.
    expect(onError).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("defaults to a silent no-op notifier (no throw when none provided)", async () => {
    const explodingCache: Cache = {
      query: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Cache;

    // No onError supplied: the default no-op must keep the host operation alive.
    const service = new SafeCacheService(explodingCache);
    await expect(service.query({ key: "k", fetcher: async () => "safe" })).resolves.toBe("safe");
  });

  test("forwards a real provider-level error to the notifier wired via the module", async () => {
    // Build a cache whose provider get() throws. With core's default fail-open
    // behavior the query already recovers, so this asserts the end-to-end module
    // wiring stays fail-safe for a genuine provider fault.
    const failingProvider: CacheProvider = {
      name: "failing",
      get: async () => {
        throw new Error("redis unreachable");
      },
      set: async () => {},
      delete: async () => {},
    };
    const cache = createCache({
      namespace: "nestjs",
      provider: failingProvider,
      defaultTtl: "1m",
      // Opt into fail-closed at the CORE level so the throw reaches the adapter,
      // proving the adapter's own net catches it and keeps the request alive.
      safety: { failOpen: false },
    });

    const onError = vi.fn();
    const module = SafeCacheModule.forRoot({ cache, onError });
    const resolved = await resolveProviders(module);
    const service = resolved.get(SafeCacheService) as SafeCacheService;

    const opts: QueryOptions<string> = { key: "k", fetcher: async () => "origin-value" };
    await expect(service.query(opts)).resolves.toBe("origin-value");
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
