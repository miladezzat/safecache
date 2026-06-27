import { describe, expect, test, vi } from "vitest";
import {
  createCache,
  jsonSerializer,
  type CacheEvent,
  type CacheEventBus,
  type CacheLock,
  type CacheLockHandle,
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

class InlineEventBus implements CacheEventBus {
  readonly published: CacheEvent[] = [];
  private readonly handlers = new Set<(event: CacheEvent) => Promise<void>>();

  async publish(event: CacheEvent) {
    this.published.push(event);
    for (const handler of this.handlers) {
      await handler(event);
    }
  }

  async subscribe(handler: (event: CacheEvent) => Promise<void>) {
    this.handlers.add(handler);
    return async () => {
      this.handlers.delete(handler);
    };
  }
}

// Mutates the event payload after it was signed, simulating an on-the-wire tamper.
class TamperingEventBus extends InlineEventBus {
  override async publish(event: CacheEvent) {
    await super.publish({ ...event, key: "user:HIJACKED", tag: "user:HIJACKED" });
  }
}

// A provider that honors ttl: keys physically disappear from get() once their stored
// lifetime has elapsed (as Redis/Valkey/Memcached would), driven by a shared clock.
class TtlHonoringProvider implements CacheProvider {
  readonly name = "ttl-honoring";
  readonly values = new Map<string, string | Uint8Array>();
  private readonly expiries = new Map<string, number>();
  lastTtlMs = -1;

  constructor(private readonly clock: { now(): number }) {}

  async get(key: string) {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && this.clock.now() >= expiry) {
      this.values.delete(key);
      this.expiries.delete(key);
      return null;
    }
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string | Uint8Array, options: { ttlMs: number }) {
    this.lastTtlMs = options.ttlMs;
    this.values.set(key, value);
    this.expiries.set(key, this.clock.now() + options.ttlMs);
  }

  async delete(key: string) {
    this.values.delete(key);
    this.expiries.delete(key);
  }
}

class SharedMemoryLock implements CacheLock {
  private readonly locked = new Set<string>();

  async acquire(key: string): Promise<CacheLockHandle | null> {
    if (this.locked.has(key)) {
      return null;
    }
    this.locked.add(key);
    return {
      release: async () => {
        this.locked.delete(key);
      },
    };
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

  test("provider get errors can fail closed", async () => {
    const provider = new RawMapProvider();
    provider.getError = new Error("down");
    const cache = createCache({
      namespace: "app",
      provider,
      defaultTtl: "1m",
      safety: { failOpen: false },
    });

    await expect(cache.query({ key: "k", fetcher: async () => "fresh" })).rejects.toThrow("down");
  });

  test("failOpen:false rethrows read errors while still recording the circuit-breaker failure", async () => {
    const clock = new ManualClock();
    const provider = new RawMapProvider();
    provider.getError = new Error("down");
    const cache = createCache({
      namespace: "app",
      provider,
      clock,
      defaultTtl: "1m",
      safety: {
        failOpen: false,
        circuitBreaker: { enabled: true, failureThreshold: 1, resetAfter: "10ms" },
      },
    });

    // failOpen:false must propagate the provider read error instead of degrading.
    await expect(cache.query({ key: "k", fetcher: async () => "fresh" })).rejects.toThrow("down");
    // Bookkeeping must still run: the single failure trips the threshold-1 breaker.
    expect(cache.stats().circuitBreakerOpen).toBe(true);
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

  test("distributed lock prevents cross-instance stampede", async () => {
    const provider = new RawMapProvider();
    const lock = new SharedMemoryLock();
    const first = createCache({
      namespace: "app",
      provider,
      defaultTtl: "1m",
      distributed: { lock },
    });
    const second = createCache({
      namespace: "app",
      provider,
      defaultTtl: "1m",
      distributed: { lock },
    });
    const fetcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "fresh";
    });

    const results = await Promise.all([
      first.query({ key: "hot", fetcher }),
      second.query({ key: "hot", fetcher }),
    ]);

    expect(results).toEqual(["fresh", "fresh"]);
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

  test("async plugin setup errors are emitted", async () => {
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
    });
    const errors: string[] = [];
    cache.on("error", (event) => {
      if (event.type === "error") {
        errors.push(event.error.message);
      }
    });

    cache.use({
      name: "bad-plugin",
      setup: async () => {
        throw new Error("setup failed");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toContain("setup failed");
  });

  test("distributed events invalidate other cache instances and ignore self events", async () => {
    const bus = new InlineEventBus();
    const providerA = new RawMapProvider();
    const providerB = new RawMapProvider();
    const cacheA = createCache({
      namespace: "app",
      source: "a",
      provider: providerA,
      defaultTtl: "1m",
      distributed: { events: bus },
    });
    const cacheB = createCache({
      namespace: "app",
      source: "b",
      provider: providerB,
      defaultTtl: "1m",
      distributed: { events: bus },
    });

    await cacheA.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "a-old" });
    await cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-old" });

    await cacheA.invalidateByTag("user:1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      cacheA.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "a-new" }),
    ).resolves.toBe("a-new");
    await expect(
      cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-new" }),
    ).resolves.toBe("b-new");
    expect(bus.published).toHaveLength(1);
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

  test("lock holder re-checks cache after acquiring and skips origin when a peer populated it", async () => {
    const provider = new RawMapProvider();
    // The lock grants immediately, but as a side effect (simulating a peer that won
    // the race) it writes a fresh entry into the shared provider during acquire().
    const lock: CacheLock = {
      async acquire(key: string): Promise<CacheLockHandle> {
        const entry = {
          value: "peer-value",
          tags: [],
          createdAt: 0,
          expiresAt: Date.now() + 60_000,
        };
        provider.values.set(key, JSON.stringify(entry));
        return { release: async () => {} };
      },
    };
    const cache = createCache({
      namespace: "app",
      provider,
      defaultTtl: "1m",
      distributed: { lock },
    });
    const fetcher = vi.fn(async () => "origin-value");

    await expect(cache.query({ key: "race", lock: true, fetcher })).resolves.toBe("peer-value");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("distributed lock is fail-open: acquire failure falls back to a direct fetch", async () => {
    const provider = new RawMapProvider();
    const lock: CacheLock = {
      async acquire(): Promise<CacheLockHandle | null> {
        throw new Error("lock backend unavailable");
      },
    };
    const cache = createCache({
      namespace: "app",
      provider,
      defaultTtl: "1m",
      distributed: { lock },
    });
    const errors: string[] = [];
    cache.on("error", (event) => {
      if (event.type === "error") {
        errors.push(event.error.message);
      }
    });
    const fetcher = vi.fn(async () => "fresh");

    await expect(cache.query({ key: "k", lock: true, fetcher })).resolves.toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(errors).toContain("lock backend unavailable");
  });

  test("SWR persists the stale-inclusive ttl to a TTL-honoring store", async () => {
    const clock = new ManualClock();
    const provider = new TtlHonoringProvider(clock);
    const cache = createCache({
      namespace: "app",
      provider,
      clock,
      defaultTtl: "10ms",
      safety: { staleWhileRevalidate: true },
    });
    const fetcher = vi.fn(async () => `value-${clock.now()}`);

    await cache.query({ key: "page", staleWhileRevalidate: "5ms", fetcher });

    // The physical ttl handed to the provider must cover ttl (10) + stale (5) = 15ms,
    // not the base 10ms, otherwise a TTL-honoring store evicts before the stale window.
    expect(provider.lastTtlMs).toBe(15);

    // Past the logical expiry (10ms) but inside the stale window (<15ms): the entry must
    // still be physically present on a TTL-honoring store so it can be served stale.
    clock.advance(11);
    expect(await provider.get("app::page")).not.toBeNull();
    await expect(cache.query({ key: "page", staleWhileRevalidate: "5ms", fetcher })).resolves.toBe(
      "value-0",
    );
  });

  test("a TTL-honoring store evicts a non-SWR entry once the base ttl elapses", async () => {
    const clock = new ManualClock();
    const provider = new TtlHonoringProvider(clock);
    const cache = createCache({ namespace: "app", provider, clock, defaultTtl: "10ms" });

    await cache.query({ key: "page", fetcher: async () => "v" });
    expect(await provider.get("app::page")).not.toBeNull();

    clock.advance(10);
    // No SWR window, so the physical ttl is the base ttl and the store evicts it.
    expect(await provider.get("app::page")).toBeNull();
  });

  test("non-SWR writes keep the base ttl on a TTL-honoring store", async () => {
    const clock = new ManualClock();
    const provider = new TtlHonoringProvider(clock);
    const cache = createCache({ namespace: "app", provider, clock, defaultTtl: "10ms" });

    await cache.query({ key: "k", fetcher: async () => "v" });

    expect(provider.lastTtlMs).toBe(10);
  });

  test("concurrent stale reads trigger exactly one background refresh", async () => {
    const clock = new ManualClock();
    const cache = createCache({
      namespace: "app",
      provider: new RawMapProvider(),
      clock,
      defaultTtl: "10ms",
      safety: { staleWhileRevalidate: true },
    });
    let resolveRefresh: ((value: string) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    // Seed the cache with an initial value, then move into the stale window.
    fetcher.mockResolvedValueOnce("seed");
    await cache.query({ key: "hot", staleWhileRevalidate: "1m", fetcher });
    clock.advance(11);

    // Two concurrent stale reads should coalesce into a single background refresh.
    const reads = await Promise.all([
      cache.query({ key: "hot", staleWhileRevalidate: "1m", fetcher }),
      cache.query({ key: "hot", staleWhileRevalidate: "1m", fetcher }),
    ]);
    expect(reads).toEqual(["seed", "seed"]);

    // One seed call + exactly one refresh call (not two).
    expect(fetcher).toHaveBeenCalledTimes(2);
    resolveRefresh?.("refreshed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.stats().refreshes).toBe(1);
  });

  test("signed events are accepted by a peer sharing the secret", async () => {
    const bus = new InlineEventBus();
    const providerA = new RawMapProvider();
    const providerB = new RawMapProvider();
    const cacheA = createCache({
      namespace: "app",
      source: "a",
      provider: providerA,
      defaultTtl: "1m",
      distributed: { events: bus, signingSecret: "s3cret" },
    });
    const cacheB = createCache({
      namespace: "app",
      source: "b",
      provider: providerB,
      defaultTtl: "1m",
      distributed: { events: bus, signingSecret: "s3cret" },
    });

    await cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-old" });
    await cacheA.invalidateByTag("user:1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bus.published[0]?.signature).toBeTypeOf("string");
    await expect(
      cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-new" }),
    ).resolves.toBe("b-new");
  });

  test("tampered events are dropped and counted", async () => {
    const bus = new TamperingEventBus();
    const providerA = new RawMapProvider();
    const providerB = new RawMapProvider();
    const cacheA = createCache({
      namespace: "app",
      source: "a",
      provider: providerA,
      defaultTtl: "1m",
      distributed: { events: bus, signingSecret: "s3cret" },
    });
    const cacheB = createCache({
      namespace: "app",
      source: "b",
      provider: providerB,
      defaultTtl: "1m",
      distributed: { events: bus, signingSecret: "s3cret" },
    });
    const errors: string[] = [];
    cacheB.on("error", (event) => {
      if (event.type === "error") {
        errors.push(event.error.message);
      }
    });

    await cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-old" });
    await cacheA.invalidateByTag("user:1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The tampered event must NOT have invalidated cacheB.
    await expect(
      cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-new" }),
    ).resolves.toBe("b-old");
    expect(errors.some((message) => message.includes("signature"))).toBe(true);
    expect(cacheB.stats().errors).toBeGreaterThan(0);
  });

  test("unsigned events are dropped when a secret is configured", async () => {
    const bus = new InlineEventBus();
    const providerB = new RawMapProvider();
    const cacheB = createCache({
      namespace: "app",
      source: "b",
      provider: providerB,
      defaultTtl: "1m",
      distributed: { events: bus, signingSecret: "s3cret" },
    });
    const errors: string[] = [];
    cacheB.on("error", (event) => {
      if (event.type === "error") {
        errors.push(event.error.message);
      }
    });

    await cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-old" });

    // An attacker publishes an unsigned invalidation directly onto the bus.
    await bus.publish({
      id: "forged-1",
      type: "invalidate:tag",
      source: "attacker",
      timestamp: Date.now(),
      namespace: "app",
      tag: "user:1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      cacheB.query({ key: "user:1", tags: ["user:1"], fetcher: async () => "b-new" }),
    ).resolves.toBe("b-old");
    expect(errors.some((message) => message.includes("signature"))).toBe(true);
  });
});
