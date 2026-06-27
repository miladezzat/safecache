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

    const tokenProvider = module.providers[0];
    const serviceProvider = module.providers[1];
    const resolvedCache = await tokenProvider?.useFactory?.();
    const service = await serviceProvider?.useFactory?.();

    expect(calls).toBe(1);
    expect(resolvedCache).toBe(cache);
    expect(service).toBeInstanceOf(SafeCacheService);
    expect((service as SafeCacheService).raw).toBe(cache);
  });
});
