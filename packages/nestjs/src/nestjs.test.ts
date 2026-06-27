import { describe, expect, test } from "vitest";
import { createCache } from "@safecache/core";
import { SafeCacheModule, SafeCacheService } from "./index";

describe("SafeCacheModule", () => {
  test("forRoot creates a dynamic-module-like provider", () => {
    const cache = createCache({
      namespace: "nestjs",
      provider: {
        name: "noop",
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      defaultTtl: "1m",
    });

    const module = SafeCacheModule.forRoot({ cache });

    expect(module.module).toBe(SafeCacheModule);
    expect(module.providers[0]?.useValue).toBe(cache);
  });

  test("SafeCacheService delegates to cache", async () => {
    const cache = createCache({
      namespace: "nestjs",
      provider: {
        name: "noop",
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      defaultTtl: "1m",
    });
    const service = new SafeCacheService(cache);

    await expect(service.query({ key: "k", fetcher: async () => "v" })).resolves.toBe("v");
  });

  test("forRootAsync shares one cache instance between token and service providers", async () => {
    const cache = createCache({
      namespace: "nestjs",
      provider: {
        name: "noop",
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      defaultTtl: "1m",
    });
    let calls = 0;
    const module = SafeCacheModule.forRootAsync({
      useFactory: async () => {
        calls += 1;
        return cache;
      },
    });

    // Simulate the NestJS DI container resolving each provider exactly once.
    // SAFE_CACHE is built from the user factory; SafeCacheService is built from
    // a factory that injects the already-resolved SAFE_CACHE token.
    const resolved = new Map<unknown, unknown>();
    for (const provider of module.providers) {
      if (provider.useFactory) {
        const deps = (provider.inject ?? []).map((token) => resolved.get(token));
        resolved.set(provider.provide, await provider.useFactory(...(deps as never[])));
      } else {
        resolved.set(provider.provide, provider.useValue);
      }
    }

    const resolvedCache = resolved.get(module.providers[0]!.provide);
    const service = resolved.get(SafeCacheService);

    // The user factory must run exactly once (no duplicate Cache instances,
    // duplicate connections, or double subscriptions).
    expect(calls).toBe(1);
    expect(resolvedCache).toBe(cache);
    expect(service).toBeInstanceOf(SafeCacheService);
    // SAFE_CACHE and SafeCacheService share the same underlying instance.
    expect((service as SafeCacheService).raw).toBe(cache);
    expect((service as SafeCacheService).raw).toBe(resolvedCache);
  });
});
