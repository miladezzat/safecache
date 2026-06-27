import { describe, expect, test } from "vitest";
import { redisLock } from "./index";

interface StoredValue {
  value: string;
  // Absolute expiry in ms epoch; undefined means no TTL set.
  expiresAt: number | undefined;
}

/**
 * In-memory redis fake that emulates the subset of behaviour the lock relies on,
 * including server-side `eval` for the compare-and-delete (release) and
 * compare-and-extend (renew) Lua scripts. The script bodies are matched
 * structurally rather than executed, which is enough to exercise the token
 * fencing semantics the lock depends on.
 */
class FakeRedisLockClient {
  readonly store = new Map<string, StoredValue>();

  async set(key: string, value: string, options: { NX?: boolean; PX?: number }) {
    if (options.NX && this.store.has(key)) {
      return null;
    }
    const expiresAt = options.PX === undefined ? undefined : Date.now() + options.PX;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async get(key: string) {
    return this.store.get(key)?.value ?? null;
  }

  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    const key = options.keys[0];
    const token = options.arguments[0];
    if (key === undefined || token === undefined) {
      return 0;
    }
    const current = this.store.get(key);
    const owns = current?.value === token;

    if (script.includes('"del"')) {
      // Release script: compare-and-delete.
      if (!owns) {
        return 0;
      }
      this.store.delete(key);
      return 1;
    }

    if (script.includes('"pexpire"')) {
      // Renew script: compare-and-extend.
      if (!owns || current === undefined) {
        return 0;
      }
      const ttl = Number(options.arguments[1]);
      current.expiresAt = Date.now() + ttl;
      return 1;
    }

    return 0;
  }
}

describe("redisLock", () => {
  test("allows one owner and releases only the matching token", async () => {
    const redis = new FakeRedisLockClient();
    const lock = redisLock(redis, { prefix: "locks" });

    const first = await lock.acquire("user:1", 1000);
    const second = await lock.acquire("user:1", 1000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await first?.release();
    expect(await lock.acquire("user:1", 1000)).not.toBeNull();
  });

  test("exposes the fencing token on the handle", async () => {
    const redis = new FakeRedisLockClient();
    const lock = redisLock(redis, { prefix: "locks", tokenFactory: () => "tok-1" });

    const handle = await lock.acquire("user:fence", 1000);

    expect(handle?.token).toBe("tok-1");
    expect(redis.store.get("locks:user:fence")?.value).toBe("tok-1");
  });

  test("release with the correct token deletes the lock (eval path)", async () => {
    const redis = new FakeRedisLockClient();
    const lock = redisLock(redis, { prefix: "locks", tokenFactory: () => "owner-token" });

    const handle = await lock.acquire("res", 1000);
    expect(handle).not.toBeNull();
    expect(redis.store.has("locks:res")).toBe(true);

    await handle?.release();

    expect(redis.store.has("locks:res")).toBe(false);
  });

  test("release with a foreign token is a no-op (does not delete someone else's lock)", async () => {
    const redis = new FakeRedisLockClient();

    // Our owner acquires the lock and holds a fencing token.
    const lock = redisLock(redis, { prefix: "locks", tokenFactory: () => "token-A" });
    const handle = await lock.acquire("shared", 1000);
    expect(handle?.token).toBe("token-A");

    // Simulate the lock expiring and being re-acquired by a different owner: the
    // stored token no longer matches our handle's fencing token.
    redis.store.set("locks:shared", { value: "token-B", expiresAt: undefined });

    // The stale owner (token-A) releasing must NOT delete token-B's lock.
    await handle?.release();

    expect(redis.store.has("locks:shared")).toBe(true);
    expect(redis.store.get("locks:shared")?.value).toBe("token-B");
  });

  test("renew with the correct token extends TTL and returns true", async () => {
    const redis = new FakeRedisLockClient();
    const lock = redisLock(redis, { prefix: "locks", tokenFactory: () => "owner" });

    const handle = await lock.acquire("res", 1000);
    const before = redis.store.get("locks:res")?.expiresAt;
    expect(before).toBeDefined();

    // Advance perceived time slightly so the new expiry is strictly later.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const renewed = await handle?.renew(5000);
    expect(renewed).toBe(true);

    const after = redis.store.get("locks:res")?.expiresAt;
    expect(after).toBeDefined();
    expect(after as number).toBeGreaterThan(before as number);
  });

  test("renew with a foreign token returns false and does not extend", async () => {
    const redis = new FakeRedisLockClient();
    const lock = redisLock(redis, { prefix: "locks", tokenFactory: () => "stale-owner" });

    const handle = await lock.acquire("res", 1000);
    const original = redis.store.get("locks:res");
    expect(original).toBeDefined();

    // Lock is taken over by a new owner (token mismatch).
    redis.store.set("locks:res", { value: "new-owner", expiresAt: original?.expiresAt });
    const expiryBefore = redis.store.get("locks:res")?.expiresAt;

    const renewed = await handle?.renew(5000);
    expect(renewed).toBe(false);
    expect(redis.store.get("locks:res")?.value).toBe("new-owner");
    expect(redis.store.get("locks:res")?.expiresAt).toBe(expiryBefore);
  });

  test("release fails safe when eval is unavailable (does not delete)", async () => {
    // A client without eval support must not fall back to a racy GET-then-DEL.
    const store = new Map<string, string>();
    const noEvalClient = {
      async set(key: string, value: string, options: { NX: true; PX: number }) {
        void options;
        if (store.has(key)) {
          return null;
        }
        store.set(key, value);
        return "OK" as const;
      },
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async del(key: string) {
        return store.delete(key) ? 1 : 0;
      },
    };

    const lock = redisLock(noEvalClient, { prefix: "locks", tokenFactory: () => "tok" });
    const handle = await lock.acquire("res", 1000);
    expect(handle).not.toBeNull();

    await handle?.release();
    // Without eval, release is a safe no-op: the lock remains until it expires.
    expect(store.has("locks:res")).toBe(true);

    // renew without eval reports the lock is no longer guaranteed held.
    expect(await handle?.renew(1000)).toBe(false);
  });
});
