import { describe, expect, test, vi } from "vitest";
import { createCache } from "@safecache/core";
import { Cached, CacheSync, withSafeCache } from "./index";

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
});
