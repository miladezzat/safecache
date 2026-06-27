import { describe, expect, test } from "vitest";
import { memoryProvider } from "./index";

class ManualClock {
  private current = 0;

  now() {
    return this.current;
  }

  advance(ms: number) {
    this.current += ms;
  }
}

describe("memoryProvider", () => {
  test("stores values with ttl and removes expired values on access", async () => {
    const clock = new ManualClock();
    const provider = memoryProvider({ clock, ttl: "10ms" });

    await provider.set("key", "value", { ttlMs: 10 });
    await expect(provider.get("key")).resolves.toBe("value");
    clock.advance(11);
    await expect(provider.get("key")).resolves.toBeNull();
  });

  test("supports tag indexes, clear, health, and max entries", async () => {
    const provider = memoryProvider({ maxEntries: 1 });

    await provider.set("a", "A", { ttlMs: 1000 });
    await provider.tagIndex.addTags("scope", "a", ["letters"], 1000);
    await expect(provider.tagIndex.getKeysByTag("scope", "letters")).resolves.toEqual(["a"]);

    await provider.set("b", "B", { ttlMs: 1000 });
    await expect(provider.get("a")).resolves.toBeNull();
    await expect(provider.get("b")).resolves.toBe("B");
    await expect(provider.health()).resolves.toMatchObject({ ok: true });

    await provider.clear();
    await expect(provider.get("b")).resolves.toBeNull();
  });

  test("treats ttlMs <= 0 as no-store and never returns such an entry", async () => {
    const clock = new ManualClock();
    const provider = memoryProvider({ clock });

    await provider.set("zero", "v", { ttlMs: 0 });
    await expect(provider.get("zero")).resolves.toBeNull();
    await expect(provider.health()).resolves.toMatchObject({ details: { entries: 0 } });

    await provider.set("neg", "v", { ttlMs: -5 });
    await expect(provider.get("neg")).resolves.toBeNull();

    // A no-store set must also drop any prior value/tags for that key.
    await provider.set("k", "first", { ttlMs: 1000 });
    await provider.tagIndex.addTags("scope", "k", ["t"], 1000);
    await provider.set("k", "second", { ttlMs: 0 });
    await expect(provider.get("k")).resolves.toBeNull();
    await expect(provider.tagIndex.getKeysByTag("scope", "k")).resolves.toEqual([]);
  });

  test("round-trips binary (Uint8Array) values", async () => {
    const provider = memoryProvider();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);

    await provider.set("bin", bytes, { ttlMs: 1000 });
    const out = await provider.get("bin");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).toEqual(bytes);
  });

  test("evicts the least-recently-used entry, not the oldest by insertion", async () => {
    const provider = memoryProvider({ maxEntries: 2 });

    await provider.set("a", "A", { ttlMs: 1000 });
    await provider.set("b", "B", { ttlMs: 1000 });
    // Touch "a" so it becomes most-recently-used; "b" is now the LRU.
    await expect(provider.get("a")).resolves.toBe("A");

    await provider.set("c", "C", { ttlMs: 1000 });

    await expect(provider.get("b")).resolves.toBeNull(); // LRU evicted
    await expect(provider.get("a")).resolves.toBe("A");
    await expect(provider.get("c")).resolves.toBe("C");
  });

  test("re-setting a key refreshes its recency", async () => {
    const provider = memoryProvider({ maxEntries: 2 });

    await provider.set("a", "A", { ttlMs: 1000 });
    await provider.set("b", "B", { ttlMs: 1000 });
    // Re-set "a": it becomes most-recently-used, leaving "b" as the LRU.
    await provider.set("a", "A2", { ttlMs: 1000 });

    await provider.set("c", "C", { ttlMs: 1000 });

    await expect(provider.get("b")).resolves.toBeNull();
    await expect(provider.get("a")).resolves.toBe("A2");
    await expect(provider.get("c")).resolves.toBe("C");
  });

  describe("tag index", () => {
    test("adds, looks up, and removes keys by exact match", async () => {
      const provider = memoryProvider();

      await provider.tagIndex.addTags("scope", "key-a", ["users"], 1000);
      await provider.tagIndex.addTags("scope", "key-b", ["users"], 1000);
      await expect(provider.tagIndex.getKeysByTag("scope", "users")).resolves.toEqual([
        "key-a",
        "key-b",
      ]);

      await provider.tagIndex.removeKey("scope", "key-a");
      await expect(provider.tagIndex.getKeysByTag("scope", "users")).resolves.toEqual(["key-b"]);
    });

    test("removeKey does not match the wrong key via suffix collision", async () => {
      const provider = memoryProvider();

      // "key" is a suffix of "prefix-key"; a naive endsWith() index would wrongly
      // drop "prefix-key" when removing "key".
      await provider.tagIndex.addTags("scope", "key", ["tag"], 1000);
      await provider.tagIndex.addTags("scope", "prefix-key", ["tag"], 1000);

      await provider.tagIndex.removeKey("scope", "key");

      await expect(provider.tagIndex.getKeysByTag("scope", "tag")).resolves.toEqual(["prefix-key"]);
    });

    test("delete purges a key's tags without touching suffix-colliding keys", async () => {
      const provider = memoryProvider();

      await provider.set("key", "v", { ttlMs: 1000 });
      await provider.set("prefix-key", "v", { ttlMs: 1000 });
      await provider.tagIndex.addTags("scope", "key", ["tag"], 1000);
      await provider.tagIndex.addTags("scope", "prefix-key", ["tag"], 1000);

      await provider.delete("key");

      // Only "key" was removed from the tag index; the suffix-sharing key stays.
      await expect(provider.tagIndex.getKeysByTag("scope", "tag")).resolves.toEqual(["prefix-key"]);
    });

    test("expiry-driven eviction purges the expired key's tags exactly", async () => {
      const clock = new ManualClock();
      const provider = memoryProvider({ clock });

      await provider.set("key", "v", { ttlMs: 10 });
      await provider.set("prefix-key", "v", { ttlMs: 10 });
      await provider.tagIndex.addTags("scope", "key", ["tag"], 10);
      await provider.tagIndex.addTags("scope", "prefix-key", ["tag"], 10);

      clock.advance(11);
      // Accessing the expired key triggers eviction + exact tag cleanup.
      await expect(provider.get("key")).resolves.toBeNull();

      await expect(provider.tagIndex.getKeysByTag("scope", "tag")).resolves.toEqual(["prefix-key"]);
    });

    test("removeKeyFromAllScopes only clears the exact key across scopes", async () => {
      const provider = memoryProvider();

      await provider.tagIndex.addTags("scope-1", "key", ["tag"], 1000);
      await provider.tagIndex.addTags("scope-2", "key", ["tag"], 1000);
      await provider.tagIndex.addTags("scope-1", "other", ["tag"], 1000);

      await provider.delete("key");

      await expect(provider.tagIndex.getKeysByTag("scope-1", "tag")).resolves.toEqual(["other"]);
      await expect(provider.tagIndex.getKeysByTag("scope-2", "tag")).resolves.toEqual([]);
    });

    test("clear empties both the value store and the tag index", async () => {
      const provider = memoryProvider();

      await provider.set("key", "v", { ttlMs: 1000 });
      await provider.tagIndex.addTags("scope", "key", ["tag"], 1000);

      await provider.clear();

      await expect(provider.get("key")).resolves.toBeNull();
      await expect(provider.tagIndex.getKeysByTag("scope", "tag")).resolves.toEqual([]);
    });
  });
});
