import { describe, expect, test, vi } from "vitest";
import { memcachedProvider, type MemcachedClient } from "./index";

const RELATIVE_BOUND = 2_592_000; // 30 days in seconds (Memcached relative-TTL ceiling)

class FakeMemcached {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.ttls.set(key, ttlSeconds);
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async flush() {
    this.values.clear();
  }

  async version() {
    return "1.6.0";
  }
}

describe("memcachedProvider", () => {
  test("stores values and exposes companion tag index", async () => {
    const provider = memcachedProvider(new FakeMemcached());

    await provider.set("key", "value", { ttlMs: 1500 });
    await provider.tagIndex.addTags("scope", "key", ["tag"], 1500);

    expect(await provider.get("key")).toBe("value");
    expect(await provider.tagIndex.getKeysByTag("scope", "tag")).toEqual(["key"]);
    await provider.delete("key");
    expect(await provider.get("key")).toBeNull();
    expect(await provider.health()).toMatchObject({ ok: true });
  });

  test("round-trips arbitrary binary bytes losslessly", async () => {
    const provider = memcachedProvider(new FakeMemcached());
    // Every byte value plus a few sequences that a UTF-8 decoder would mangle.
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) {
      allBytes[i] = i;
    }
    const loneSurrogate = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc0, 0xed, 0xa0, 0x80]);

    await provider.set("bytes", allBytes, { ttlMs: 1000 });
    await provider.set("mangle", loneSurrogate, { ttlMs: 1000 });

    const readBytes = await provider.get("bytes");
    const readMangle = await provider.get("mangle");

    expect(readBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(readBytes as Uint8Array)).toEqual(Array.from(allBytes));
    expect(Array.from(readMangle as Uint8Array)).toEqual(Array.from(loneSurrogate));
  });

  test("string values remain strings and never decode as binary", async () => {
    const provider = memcachedProvider(new FakeMemcached());
    // A string that, without a sentinel, could be confused with an encoded form.
    const tricky = "b" + Buffer.from([1, 2, 3]).toString("base64");

    await provider.set("plain", "hello world", { ttlMs: 1000 });
    await provider.set("tricky", tricky, { ttlMs: 1000 });

    const plain = await provider.get("plain");
    const back = await provider.get("tricky");

    expect(plain).toBe("hello world");
    expect(typeof plain).toBe("string");
    expect(back).toBe(tricky);
    expect(typeof back).toBe("string");
  });

  test("keeps sub-30-day TTLs relative", async () => {
    const fake = new FakeMemcached();
    const provider = memcachedProvider(fake);

    await provider.set("k", "v", { ttlMs: 30 * 24 * 60 * 60 * 1_000 }); // exactly 30 days

    expect(fake.ttls.get("k")).toBe(2_592_000);
  });

  test("converts TTLs over 30 days to an absolute epoch so they do not expire instantly", async () => {
    const fake = new FakeMemcached();
    const provider = memcachedProvider(fake);
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      const seconds = 2_592_000 + 1; // one second past the relative bound
      await provider.set("k", "v", { ttlMs: seconds * 1_000 });

      const stored = fake.ttls.get("k");
      expect(stored).toBe(Math.floor(now / 1_000) + seconds);
      // Crucially it is an absolute future timestamp, not a tiny relative value.
      expect(stored).toBeGreaterThan(RELATIVE_BOUND);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("tag index matches tags by exact (scope, tag) without suffix collisions", async () => {
    const provider = memcachedProvider(new FakeMemcached());

    await provider.tagIndex.addTags("scope", "k1", ["tag"], 1000);
    await provider.tagIndex.addTags("scope", "k2", ["othertag"], 1000);

    // "tag" must NOT match "othertag" (the old suffix-based index collided here).
    expect(await provider.tagIndex.getKeysByTag("scope", "tag")).toEqual(["k1"]);
    expect(await provider.tagIndex.getKeysByTag("scope", "othertag")).toEqual(["k2"]);

    // Scope isolation: same tag in a different scope is independent.
    await provider.tagIndex.addTags("other", "k3", ["tag"], 1000);
    expect(await provider.tagIndex.getKeysByTag("scope", "tag")).toEqual(["k1"]);
    expect(await provider.tagIndex.getKeysByTag("other", "tag")).toEqual(["k3"]);
  });

  test("clear() routes to onError (and does not throw) when flush is absent", async () => {
    const errors: Error[] = [];
    const client: MemcachedClient = {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    };
    const provider = memcachedProvider(client, { onError: (error) => errors.push(error) });

    await expect(provider.clear()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/flush/);
  });

  test("clear() can opt into fail-closed via propagateInvalidationErrors", async () => {
    const client: MemcachedClient = {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    };
    const provider = memcachedProvider(client, { propagateInvalidationErrors: true });

    await expect(provider.clear()).rejects.toThrow(/flush/);
  });

  test("a thrown cache error is swallowed + notified and never breaks the host", async () => {
    const errors: Error[] = [];
    const boom = new Error("memcached unreachable");
    const client: MemcachedClient = {
      async get() {
        throw boom;
      },
      async set() {
        throw boom;
      },
      async delete() {
        throw boom;
      },
    };
    const provider = memcachedProvider(client, { onError: (error) => errors.push(error) });

    // The host operation continues as if the cache were absent.
    await expect(provider.set("k", "v", { ttlMs: 1000 })).resolves.toBeUndefined();
    await expect(provider.get("k")).resolves.toBeNull();
    await expect(provider.delete("k")).resolves.toBeUndefined();

    expect(errors).toHaveLength(3);
    expect(errors.every((error) => error === boom)).toBe(true);
  });

  test("a throwing onError notifier cannot break the host operation", async () => {
    const client: MemcachedClient = {
      async get() {
        throw new Error("boom");
      },
      async set() {},
      async delete() {},
    };
    const provider = memcachedProvider(client, {
      onError: () => {
        throw new Error("notifier exploded");
      },
    });

    await expect(provider.get("k")).resolves.toBeNull();
  });
});
