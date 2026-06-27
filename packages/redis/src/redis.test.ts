import { describe, expect, test } from "vitest";
import { redisProvider, type RedisMulti, type RedisSetOptions } from "./index";

class FakeRedis {
  readonly values = new Map<string, string | Uint8Array>();
  readonly sets = new Map<string, Set<string>>();
  readonly expires = new Map<string, number>();
  now = 0;
  /** Counts how many discrete client round-trips occurred (multi+exec counts as one). */
  roundTrips = 0;

  async get(key: string) {
    this.roundTrips += 1;
    if ((this.expires.get(key) ?? Infinity) <= this.now) {
      this.values.delete(key);
      return null;
    }
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string | Uint8Array, options?: RedisSetOptions) {
    this.roundTrips += 1;
    this.setSync(key, value, options);
    return "OK";
  }

  private setSync(key: string, value: string | Uint8Array, options?: RedisSetOptions) {
    this.values.set(key, value);
    // Support both the v6 structured shape and the deprecated flat fallback.
    const px = options?.expiration?.type === "PX" ? options.expiration.value : options?.PX;
    if (px !== undefined) {
      this.expires.set(key, this.now + px);
    }
  }

  async del(...keys: string[]) {
    this.roundTrips += 1;
    return this.delSync(...keys);
  }

  private delSync(...keys: string[]) {
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
    this.roundTrips += 1;
    return this.sAddSync(key, members);
  }

  private sAddSync(key: string, members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) {
      set.add(member);
    }
    this.sets.set(key, set);
    return members.length;
  }

  async sMembers(key: string) {
    this.roundTrips += 1;
    return [...(this.sets.get(key) ?? [])];
  }

  async sRem(key: string, members: string[]) {
    this.roundTrips += 1;
    return this.sRemSync(key, members);
  }

  private sRemSync(key: string, members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) {
      set.delete(member);
    }
    return members.length;
  }

  async expire() {
    this.roundTrips += 1;
    return 1;
  }

  private expireSync() {
    return 1;
  }

  multi(): RedisMulti {
    const ops: Array<() => unknown> = [];
    const self = this;
    const tx: RedisMulti = {
      sAdd(key, members) {
        ops.push(() => self.sAddSync(key, members));
        return tx;
      },
      sRem(key, members) {
        ops.push(() => self.sRemSync(key, members));
        return tx;
      },
      expire() {
        ops.push(() => self.expireSync());
        return tx;
      },
      del(...keys) {
        ops.push(() => self.delSync(...keys));
        return tx;
      },
      async exec() {
        // Apply all buffered commands atomically as a single round-trip.
        self.roundTrips += 1;
        return ops.map((op) => op());
      },
    };
    return tx;
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

  test("set uses node-redis v6 structured PX expiration", async () => {
    const calls: Array<RedisSetOptions | undefined> = [];
    const redis = new FakeRedis();
    const original = redis.set.bind(redis);
    redis.set = (key, value, options) => {
      calls.push(options);
      return original(key, value, options);
    };
    const provider = redisProvider(redis);

    await provider.set("k", "v", { ttlMs: 5000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ expiration: { type: "PX", value: 5000 } });
  });

  test("set omits PX entirely when ttlMs is zero or negative", async () => {
    const calls: Array<RedisSetOptions | undefined> = [];
    const redis = new FakeRedis();
    const original = redis.set.bind(redis);
    redis.set = (key, value, options) => {
      calls.push(options);
      return original(key, value, options);
    };
    const provider = redisProvider(redis);

    await provider.set("zero", "v", { ttlMs: 0 });
    await provider.set("neg", "v", { ttlMs: -10 });

    // No expiration option is ever forwarded for a non-positive TTL.
    expect(calls).toEqual([undefined, undefined]);
    // And the values are stored without an expiry.
    redis.now = 1_000_000;
    expect(await redis.get("zero")).toBe("v");
    expect(await redis.get("neg")).toBe("v");
  });

  test("health coerces a non-string ping reply", async () => {
    const redis = new FakeRedis();
    // RESP3 / Buffer-mode clients may resolve ping() to a non-string value.
    redis.ping = async () => Buffer.from("PONG") as unknown as string;
    const provider = redisProvider(redis);

    const health = await provider.health();
    expect(health).toEqual({ ok: true, details: { response: "PONG" } });
  });

  test("health reports not-ok for an unexpected ping reply without throwing", async () => {
    const redis = new FakeRedis();
    redis.ping = async () => 42 as unknown as string;
    const provider = redisProvider(redis);

    const health = await provider.health();
    expect(health).toEqual({ ok: false, details: { response: "42" } });
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

  test("addTags commits all tag-index writes in a single atomic transaction", async () => {
    const redis = new FakeRedis();
    const provider = redisProvider(redis);

    redis.roundTrips = 0;
    await provider.tagIndex.addTags("scope", "key-a", ["t1", "t2", "t3"], 1000);

    // Without atomicity this would be 2N+1 = 7 separate round-trips; via MULTI it is one exec().
    expect(redis.roundTrips).toBe(1);
    expect(await provider.tagIndex.getKeysByTag("scope", "t1")).toEqual(["key-a"]);
    expect(await provider.tagIndex.getKeysByTag("scope", "t2")).toEqual(["key-a"]);
    expect(await provider.tagIndex.getKeysByTag("scope", "t3")).toEqual(["key-a"]);
  });

  test("removeKey and removeTag commit their mutations atomically", async () => {
    const redis = new FakeRedis();
    const provider = redisProvider(redis);

    await provider.tagIndex.addTags("scope", "key-a", ["t1", "t2"], 1000);
    await provider.tagIndex.addTags("scope", "key-b", ["t1"], 1000);

    redis.roundTrips = 0;
    await provider.tagIndex.removeKey("scope", "key-a", ["t1", "t2"]);
    // One exec() for the sRem(s) + del; no reverse-index read needed (tags supplied).
    expect(redis.roundTrips).toBe(1);
    expect(await provider.tagIndex.getKeysByTag("scope", "t1")).toEqual(["key-b"]);
    expect(await provider.tagIndex.getKeysByTag("scope", "t2")).toEqual([]);

    redis.roundTrips = 0;
    await provider.tagIndex.removeTag("scope", "t1");
    // One sMembers snapshot read + one exec().
    expect(redis.roundTrips).toBe(2);
    expect(await provider.tagIndex.getKeysByTag("scope", "t1")).toEqual([]);
  });

  test("tag index falls back to non-atomic writes when multi() is unavailable", async () => {
    const redis = new FakeRedis();
    // Mirror the optional contract: a client without MULTI exposes no multi().
    delete (redis as { multi?: unknown }).multi;
    const provider = redisProvider(redis);

    await provider.tagIndex.addTags("scope", "key-a", ["users"], 1000);
    await provider.tagIndex.addTags("scope", "key-b", ["users"], 1000);
    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual(["key-a", "key-b"]);

    await provider.tagIndex.removeKey("scope", "key-a");
    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual(["key-b"]);

    await provider.tagIndex.removeTag("scope", "users");
    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual([]);
  });
});
