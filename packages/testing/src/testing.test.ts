import { describe, expect, test, vi } from "vitest";
import { createTestCache, FakeClock, FakeProvider, MockEventBus } from "./index";

describe("testing utilities", () => {
  test("createTestCache returns a cache with deterministic fake clock", async () => {
    const { cache, clock } = createTestCache({ defaultTtl: "10ms" });
    const fetcher = vi.fn(async () => "value");

    await cache.query({ key: "k", fetcher });
    clock.advance(11);
    await cache.query({ key: "k", fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("FakeProvider and MockEventBus expose deterministic state", async () => {
    const clock = new FakeClock();
    const provider = new FakeProvider(clock);
    const events = new MockEventBus();
    const seen: string[] = [];

    await provider.set("k", "v", { ttlMs: 10 });
    await events.subscribe(async (event) => {
      seen.push(event.type);
    });
    await events.publish({
      id: "1",
      type: "invalidate:key",
      source: "test",
      timestamp: clock.now(),
      namespace: "app",
      key: "k",
    });

    expect(await provider.get("k")).toBe("v");
    expect(seen).toEqual(["invalidate:key"]);
  });

  describe("FakeClock", () => {
    test("set jumps the clock to an absolute time and expires entries", async () => {
      const clock = new FakeClock(100);
      const provider = new FakeProvider(clock);

      await provider.set("k", "v", { ttlMs: 50 }); // expiresAt = 150
      expect(await provider.get("k")).toBe("v");

      clock.set(150); // at-or-after expiry => expired
      expect(await provider.get("k")).toBeNull();
    });

    test("set can move the clock backwards", () => {
      const clock = new FakeClock(1000);
      clock.set(0);
      expect(clock.now()).toBe(0);
    });
  });

  describe("FakeProvider", () => {
    test("delete removes a single key", async () => {
      const provider = new FakeProvider();
      await provider.set("a", "1", { ttlMs: 1000 });
      await provider.set("b", "2", { ttlMs: 1000 });

      await provider.delete("a");

      expect(await provider.get("a")).toBeNull();
      expect(await provider.get("b")).toBe("2");
    });

    test("clear removes every key", async () => {
      const provider = new FakeProvider();
      await provider.set("a", "1", { ttlMs: 1000 });
      await provider.set("b", "2", { ttlMs: 1000 });

      await provider.clear();

      expect(await provider.get("a")).toBeNull();
      expect(await provider.get("b")).toBeNull();
    });

    test("exposes a working tagIndex backed by core's InMemoryTagIndex", async () => {
      const provider = new FakeProvider();
      await provider.tagIndex.addTags("scope", "key-1", ["t"], 1000);

      expect(await provider.tagIndex.getKeysByTag("scope", "t")).toEqual(["key-1"]);

      await provider.tagIndex.removeTag("scope", "t");
      expect(await provider.tagIndex.getKeysByTag("scope", "t")).toEqual([]);
    });
  });

  describe("MockEventBus", () => {
    test("unsubscribe stops delivering future events", async () => {
      const events = new MockEventBus();
      const seen: string[] = [];
      const unsubscribe = await events.subscribe(async (event) => {
        seen.push(event.type);
      });

      const base = {
        source: "test",
        timestamp: 0,
        namespace: "app",
        key: "k",
      } as const;

      await events.publish({ id: "1", type: "invalidate:key", ...base });
      await unsubscribe();
      await events.publish({ id: "2", type: "invalidate:key", ...base });

      // Handler only saw the first event; both are still recorded on the bus.
      expect(seen).toEqual(["invalidate:key"]);
      expect(events.events.map((e) => e.id)).toEqual(["1", "2"]);
    });
  });

  describe("createTestCache", () => {
    test("honors a caller-supplied FakeClock", () => {
      const clock = new FakeClock(500);
      const { clock: returned } = createTestCache({ clock });

      expect(returned).toBe(clock);
      expect(returned.now()).toBe(500);
    });

    test("uses a caller-supplied custom provider over the default", async () => {
      const clock = new FakeClock();
      const provider = new FakeProvider(clock);
      const setSpy = vi.spyOn(provider, "set");
      const { cache } = createTestCache({ clock, provider });

      const value = await cache.query({ key: "k", fetcher: async () => "v" });

      expect(value).toBe("v");
      expect(setSpy).toHaveBeenCalled();
    });

    test("serves stale-while-revalidate values through the cache", async () => {
      const { cache, clock } = createTestCache({ defaultTtl: "10ms" });
      let counter = 0;
      const fetcher = vi.fn(async () => `v${++counter}`);

      // The "refresh" runtime event fires only AFTER the background refresh has
      // completed its provider write, giving us a deterministic settle signal.
      const refreshed = new Promise<void>((resolve) => {
        cache.on("refresh", () => resolve());
      });

      // Prime the cache.
      expect(await cache.query({ key: "k", fetcher, staleWhileRevalidate: true })).toBe("v1");

      // Past TTL but inside the stale window: SWR returns the stale value
      // immediately and kicks off a background refresh.
      clock.advance(11);
      expect(await cache.query({ key: "k", fetcher, staleWhileRevalidate: true })).toBe("v1");

      // Once the background refresh has stored the new value, reads see it.
      await refreshed;
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(await cache.query({ key: "k", fetcher, staleWhileRevalidate: true })).toBe("v2");
    });

    test("runs real tag-based invalidation via FakeProvider's tagIndex", async () => {
      const clock = new FakeClock();
      const provider = new FakeProvider(clock);
      const { cache } = createTestCache({ clock, provider });
      const fetcher = vi.fn(async () => "v");

      await cache.query({ key: "k", tags: ["group"], fetcher });
      await cache.query({ key: "k", tags: ["group"], fetcher });
      expect(fetcher).toHaveBeenCalledTimes(1); // second call is a hit

      await cache.invalidateByTag("group");

      await cache.query({ key: "k", tags: ["group"], fetcher });
      expect(fetcher).toHaveBeenCalledTimes(2); // invalidation forced a re-fetch
    });
  });
});
