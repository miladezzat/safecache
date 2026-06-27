import { describe, expect, test, vi } from "vitest";
import { createCache } from "@safecache/core";
import { Cached, CacheSync, setSafeCacheDecoratorErrorHandler, withSafeCache } from "./index";

class Provider {
  readonly name = "decorator-test";
  readonly values = new Map<string, string | Uint8Array>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string | Uint8Array) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

describe("decorators", () => {
  test("Cached preserves this and routes through cache.query", async () => {
    class UserService {
      calls = 0;

      @Cached({
        key: (id: string) => `user:${id}`,
        tags: (id: string) => [`user:${id}`],
        ttl: "1m",
      })
      async getUser(id: string) {
        this.calls += 1;
        return { id };
      }
    }

    const service = withSafeCache(
      new UserService(),
      createCache({ namespace: "decorators", provider: new Provider(), defaultTtl: "1m" }),
    );

    expect(await service.getUser("1")).toEqual({ id: "1" });
    expect(await service.getUser("1")).toEqual({ id: "1" });
    expect(service.calls).toBe(1);
  });

  test("CacheSync runs action and invalidates tags", async () => {
    const cache = createCache({
      namespace: "decorators",
      provider: new Provider(),
      defaultTtl: "1m",
    });
    const invalidateByTag = vi.spyOn(cache, "invalidateByTag");

    class UserService {
      @CacheSync({ tags: (id: string) => [`user:${id}`] })
      async updateUser(id: string) {
        return { id, updated: true };
      }
    }

    const service = withSafeCache(new UserService(), cache);

    await expect(service.updateUser("1")).resolves.toEqual({ id: "1", updated: true });
    expect(invalidateByTag).toHaveBeenCalledWith("user:1", { tenant: undefined });
  });

  test("Cached returns the real value when the cache throws", async () => {
    const cache = createCache({
      namespace: "decorators",
      provider: new Provider(),
      defaultTtl: "1m",
    });
    const boom = new Error("query exploded");
    vi.spyOn(cache, "query").mockRejectedValue(boom);
    const onError = vi.fn();

    class UserService {
      calls = 0;

      @Cached({
        key: (id: string) => `user:${id}`,
        ttl: "1m",
        onError,
      })
      async getUser(id: string) {
        this.calls += 1;
        return { id };
      }
    }

    const service = withSafeCache(new UserService(), cache);

    // The decorated method must still resolve to the real value...
    await expect(service.getUser("7")).resolves.toEqual({ id: "7" });
    // ...by invoking the original method directly...
    expect(service.calls).toBe(1);
    // ...and routing the cache failure to the notifier.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  test("Cached routes cache failures to the module-level handler", async () => {
    const cache = createCache({
      namespace: "decorators",
      provider: new Provider(),
      defaultTtl: "1m",
    });
    vi.spyOn(cache, "query").mockRejectedValue(new Error("nope"));
    const moduleHandler = vi.fn();
    setSafeCacheDecoratorErrorHandler(moduleHandler);

    class UserService {
      @Cached({ key: (id: string) => `user:${id}`, ttl: "1m" })
      async getUser(id: string) {
        return { id };
      }
    }

    const service = withSafeCache(new UserService(), cache);

    try {
      await expect(service.getUser("9")).resolves.toEqual({ id: "9" });
      expect(moduleHandler).toHaveBeenCalledTimes(1);
    } finally {
      setSafeCacheDecoratorErrorHandler(undefined);
    }
  });

  test("CacheSync returns the method result even when invalidation throws", async () => {
    const cache = createCache({
      namespace: "decorators",
      provider: new Provider(),
      defaultTtl: "1m",
    });
    const tagBoom = new Error("invalidateByTag failed");
    vi.spyOn(cache, "invalidateByTag").mockRejectedValue(tagBoom);
    const invalidate = vi.spyOn(cache, "invalidate").mockResolvedValue(undefined);
    const onError = vi.fn();

    class UserService {
      ran = false;

      @CacheSync({
        keys: (id: string) => [`user:${id}`],
        tags: (id: string) => [`user:${id}`, "users"],
        onError,
      })
      async updateUser(id: string) {
        this.ran = true;
        return { id, updated: true };
      }
    }

    const service = withSafeCache(new UserService(), cache);

    // The method's work succeeded, so its result must be returned despite the
    // failing tag invalidation; no error may propagate.
    await expect(service.updateUser("1")).resolves.toEqual({ id: "1", updated: true });
    expect(service.ran).toBe(true);
    // The non-failing key invalidation still ran (allSettled, not short-circuit).
    expect(invalidate).toHaveBeenCalledWith("user:1", { tenant: undefined });
    // Both failing tag invalidations were routed to the notifier.
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(tagBoom);
  });
});
