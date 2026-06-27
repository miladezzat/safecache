import { describe, expect, test } from "vitest";
import { redisProvider } from "./index";

class FakeRedis {
  readonly values = new Map<string, string | Uint8Array>();
  readonly sets = new Map<string, Set<string>>();
  readonly expires = new Map<string, number>();
  now = 0;

  async get(key: string) {
    if ((this.expires.get(key) ?? Infinity) <= this.now) {
      this.values.delete(key);
      return null;
    }
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string | Uint8Array, options?: { PX?: number }) {
    this.values.set(key, value);
    if (options?.PX) {
      this.expires.set(key, this.now + options.PX);
    }
    return "OK";
  }

  async del(...keys: string[]) {
    let count = 0;
    for (const key of keys) {
      if (this.values.delete(key)) {
        count += 1;
      }
      if (this.sets.delete(key)) {
        count += 1;
      }
    }
    return count;
  }

  async sAdd(key: string, members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) {
      set.add(member);
    }
    this.sets.set(key, set);
    return members.length;
  }

  async sMembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }

  async sRem(key: string, members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) {
      set.delete(member);
    }
    return members.length;
  }

  async expire() {
    return 1;
  }

  async ping() {
    return "PONG";
  }
}

describe("redisProvider", () => {
  test("round-trips values with ttl and reports health", async () => {
    const redis = new FakeRedis();
    const provider = redisProvider(redis);

    await provider.set("k", "v", { ttlMs: 10 });
    expect(await provider.get("k")).toBe("v");
    redis.now = 11;
    expect(await provider.get("k")).toBeNull();
    expect(await provider.health()).toMatchObject({ ok: true });
  });

  test("round-trips binary values with non-UTF8 bytes without corruption", async () => {
    const redis = new FakeRedis();
    const provider = redisProvider(redis);

    const binary = new Uint8Array([0xff, 0x00, 0xfe]);
    await provider.set("bin", binary, { ttlMs: 1000 });

    const result = await provider.get("bin");
    expect(result).not.toBeNull();
    const bytes = Uint8Array.from(
      result instanceof Uint8Array ? result : Buffer.from(result as string),
    );
    expect([...bytes]).toEqual([...binary]);
  });

  test("redis tag index tracks and removes keys by tag", async () => {
    const redis = new FakeRedis();
    const provider = redisProvider(redis);

    await provider.tagIndex.addTags("scope", "key-a", ["users"], 1000);
    await provider.tagIndex.addTags("scope", "key-b", ["users"], 1000);

    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual(["key-a", "key-b"]);
    await provider.tagIndex.removeKey("scope", "key-a", ["users"]);
    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual(["key-b"]);
    await provider.tagIndex.removeTag("scope", "users");
    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual([]);
  });

  test("redis tag index can remove a key without caller-supplied tag list", async () => {
    const redis = new FakeRedis();
    const provider = redisProvider(redis);

    await provider.tagIndex.addTags("scope", "key-a", ["users", "user:key-a"], 1000);
    await provider.tagIndex.removeKey("scope", "key-a");

    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual([]);
    expect(await provider.tagIndex.getKeysByTag("scope", "user:key-a")).toEqual([]);
  });
});
