import { describe, expect, test, vi } from "vitest";
import {
  createCache,
  jsonSerializer,
  type CachePlugin,
  type CacheProvider,
  type CacheTagIndex,
} from "./index";

class ManualClock {
  private current = 0;

  now() {
    return this.current;
  }

  advance(ms: number) {
    this.current += ms;
  }
}

class InMemoryTagIndex implements CacheTagIndex {
  private tags = new Map<string, Set<string>>();
  private keyTags = new Map<string, Set<string>>();

  async addTags(scope: string, key: string, tags: string[]) {
    const scopedKey = `${scope}::${key}`;
    const existing = this.keyTags.get(scopedKey) ?? new Set<string>();
    for (const tag of tags) {
      const scopedTag = `${scope}::${tag}`;
      const keys = this.tags.get(scopedTag) ?? new Set<string>();
      keys.add(key);
      this.tags.set(scopedTag, keys);
      existing.add(tag);
    }
    this.keyTags.set(scopedKey, existing);
  }

  async getKeysByTag(scope: string, tag: string) {
    return [...(this.tags.get(`${scope}::${tag}`) ?? [])];
  }

  async removeKey(scope: string, key: string) {
    const scopedKey = `${scope}::${key}`;
    const tags = this.keyTags.get(scopedKey) ?? new Set<string>();
    for (const tag of tags) {
      this.tags.get(`${scope}::${tag}`)?.delete(key);
    }
    this.keyTags.delete(scopedKey);
  }

  async removeTag(scope: string, tag: string) {
    const scopedTag = `${scope}::${tag}`;
    const keys = this.tags.get(scopedTag) ?? new Set<string>();
    for (const key of keys) {
      this.keyTags.get(`${scope}::${key}`)?.delete(tag);
    }
    this.tags.delete(scopedTag);
  }
}

class RawMapProvider implements CacheProvider {
  readonly name = "raw-map";
  readonly tagIndex = new InMemoryTagIndex();
  readonly values = new Map<string, string | Uint8Array>();
  getError?: Error;
  setError?: Error;

  async get(key: string) {
    if (this.getError) {
      throw this.getError;
    }
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string | Uint8Array) {
    if (this.setError) {
      throw this.setError;
    }
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async clear() {
    this.values.clear();
  }
}

describe("createCache", () => {
  test("miss calls fetcher, stores the result, and hit skips fetcher", async () => {
    const provider = new RawMapProvider();
    const cache = createCache({ namespace: "app", provider, defaultTtl: "1m" });
    const fetcher = vi.fn(async () => ({ id: "1" }));

    await expect(cache.query({ key: "user:1", fetcher })).resolves.toEqual({ id: "1" });
    await expect(cache.query({ key: "user:1", fetcher })).resolves.toEqual({ id: "1" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  test("wrap delegates to query semantics", async () => {
    const provider = new RawMapProvider();
    const cache = createCache({ namespace: "app", provider });
    const fetcher = vi.fn(async () => "wrapped");

    await expect(cache.wrap("key", fetcher, { ttl: "1m" })).resolves.toBe("wrapped");
    await expect(cache.wrap("key", fetcher, { ttl: "1m" })).resolves.toBe("wrapped");

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("requires ttl when defaultTtl is missing", async () => {
    const cache = createCache({ namespace: "app", provider: new RawMapProvider() });

    await expect(cache.query({ key: "missing-ttl", fetcher: async () => "x" })).rejects.toThrow(
      "ttl",
    );
  });

  test("ttl expiry causes a miss", async () => {
    const clock = new ManualClock();
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      clock,
      defaultTtl: "10ms",
    });
    const fetcher = vi.fn(async () => `value-${clock.now()}`);

    await expect(cache.query({ key: "k", fetcher })).resolves.toBe("value-0");
    clock.advance(11);
    await expect(cache.query({ key: "k", fetcher })).resolves.toBe("value-11");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("key and tag invalidation remove expected values only", async () => {
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      defaultTtl: "1m",
    });

    await cache.query({ key: "user:1", tags: ["users", "user:1"], fetcher: async () => "one" });
    await cache.query({ key: "user:2", tags: ["users", "user:2"], fetcher: async () => "two" });
    await cache.invalidate("user:1");

    const first = vi.fn(async () => "one-fresh");
    const second = vi.fn(async () => "two-fresh");
    await expect(cache.query({ key: "user:1", tags: ["user:1"], fetcher: first })).resolves.toBe(
      "one-fresh",
    );
    await expect(cache.query({ key: "user:2", tags: ["user:2"], fetcher: second })).resolves.toBe(
      "two",
    );

    await cache.invalidateByTag("users");
    await expect(cache.query({ key: "user:2", tags: ["user:2"], fetcher: second })).resolves.toBe(
      "two-fresh",
    );
  });

  test("namespace and tenant isolate keys", async () => {
    const provider = new RawMapProvider();
    const appA = createCache({ namespace: "a", provider, defaultTtl: "1m" });
    const appB = createCache({ namespace: "b", provider, defaultTtl: "1m" });

    await appA.query({ key: "shared", tenant: "1", fetcher: async () => "a1" });
    await appA.query({ key: "shared", tenant: "2", fetcher: async () => "a2" });
    await appB.query({ key: "shared", tenant: "1", fetcher: async () => "b1" });

    await expect(
      appA.query({ key: "shared", tenant: "1", fetcher: async () => "new" }),
    ).resolves.toBe("a1");
    await expect(
      appA.query({ key: "shared", tenant: "2", fetcher: async () => "new" }),
    ).resolves.toBe("a2");
    await expect(
      appB.query({ key: "shared", tenant: "1", fetcher: async () => "new" }),
    ).resolves.toBe("b1");
  });

  test("provider get and set errors fail open", async () => {
    const provider = new RawMapProvider();
    provider.getError = new Error("down");
    provider.setError = new Error("readonly");
    const cache = createCache({ namespace: "app", provider, defaultTtl: "1m" });
    const errors: string[] = [];
    cache.on("error", (event) => {
      if (event.type === "error") {
        errors.push(event.error.message);
      }
    });

    await expect(cache.query({ key: "k", fetcher: async () => "fresh" })).resolves.toBe("fresh");

    expect(errors).toContain("down");
    expect(errors).toContain("readonly");
  });

  test("fetcher and action errors propagate", async () => {
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      defaultTtl: "1m",
    });

    await expect(
      cache.query({ key: "k", fetcher: async () => Promise.reject(new Error("db")) }),
    ).rejects.toThrow("db");
    await expect(
      cache.mutate({ tags: ["users"], action: async () => Promise.reject(new Error("write")) }),
    ).rejects.toThrow("write");
  });

  test("mutate invalidates only after successful action", async () => {
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      defaultTtl: "1m",
    });
    await cache.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "old" });

    await expect(
      cache.mutate({ tags: ["user:1"], action: async () => Promise.reject(new Error("write")) }),
    ).rejects.toThrow("write");
    await expect(
      cache.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "new" }),
    ).resolves.toBe("old");

    await expect(cache.mutate({ tags: ["user:1"], action: async () => "updated" })).resolves.toBe(
      "updated",
    );
    await expect(
      cache.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "new" }),
    ).resolves.toBe("new");
  });

  test("concurrent misses call fetcher once with stampede prevention", async () => {
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      defaultTtl: "1m",
      safety: { preventStampede: true },
    });
    const fetcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "fresh";
    });

    await Promise.all([
      cache.query({ key: "hot", fetcher }),
      cache.query({ key: "hot", fetcher }),
      cache.query({ key: "hot", fetcher }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("stale-while-revalidate returns stale and refreshes in the background", async () => {
    const clock = new ManualClock();
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      clock,
      defaultTtl: "10ms",
      safety: { staleWhileRevalidate: true },
    });
    const fetcher = vi.fn(async () => `value-${clock.now()}`);

    await cache.query({ key: "page", staleWhileRevalidate: "1m", fetcher });
    clock.advance(11);
    await expect(cache.query({ key: "page", staleWhileRevalidate: "1m", fetcher })).resolves.toBe(
      "value-0",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(cache.query({ key: "page", staleWhileRevalidate: "1m", fetcher })).resolves.toBe(
      "value-11",
    );
  });

  test("refresh-ahead refreshes a hot key before expiry", async () => {
    const clock = new ManualClock();
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      clock,
      defaultTtl: "10ms",
    });
    const fetcher = vi.fn(async () => `value-${clock.now()}`);

    await cache.query({ key: "hot", refreshAhead: true, fetcher });
    clock.advance(6);
    await expect(cache.query({ key: "hot", refreshAhead: true, fetcher })).resolves.toBe("value-0");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(cache.query({ key: "hot", refreshAhead: true, fetcher })).resolves.toBe("value-6");
  });

  test("circuit breaker opens and resets after repeated provider failures", async () => {
    const clock = new ManualClock();
    const provider = new RawMapProvider();
    provider.getError = new Error("down");
    const cache = createCache({
      namespace: "app",
      provider,
      clock,
      defaultTtl: "1m",
      safety: {
        circuitBreaker: { enabled: true, failureThreshold: 2, resetAfter: "10ms" },
      },
    });

    await cache.query({ key: "k", fetcher: async () => "one" });
    await cache.query({ key: "k", fetcher: async () => "two" });
    provider.getError = undefined;
    await cache.query({ key: "k", fetcher: async () => "three" });
    expect(cache.stats().circuitBreakerOpen).toBe(true);
    clock.advance(11);
    await cache.query({ key: "k", fetcher: async () => "four" });
    expect(cache.stats().circuitBreakerOpen).toBe(false);
  });

  test("older version writes are rejected", async () => {
    const provider = new RawMapProvider();
    const cache = createCache({ namespace: "app", provider, defaultTtl: "1m" });

    await cache.query({ key: "versioned", version: 2, fetcher: async () => "new" });
    await cache.query({ key: "versioned", version: 1, fetcher: async () => "old" });
    await expect(cache.query({ key: "versioned", fetcher: async () => "miss" })).resolves.toBe(
      "new",
    );
  });

  test("plugin setup and shutdown run once", async () => {
    const calls: string[] = [];
    const plugin: CachePlugin = {
      name: "test",
      setup: () => {
        calls.push("setup");
      },
      shutdown: async () => {
        calls.push("shutdown");
      },
    };
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      plugins: [plugin],
    });
    cache.use(plugin);
    await cache.shutdown();
    await cache.shutdown();

    expect(calls).toEqual(["setup", "shutdown"]);
  });

  test("json serializer round-trips entries", () => {
    const entry = {
      value: { id: 1 },
      tags: ["user:1"],
      createdAt: 1,
      expiresAt: 2,
      version: 1,
    };

    expect(jsonSerializer().deserialize(jsonSerializer().serialize(entry))).toEqual(entry);
  });
});
