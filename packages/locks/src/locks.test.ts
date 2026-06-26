import { describe, expect, test } from "vitest";
import { redisLock } from "./index";

class FakeRedisLockClient {
  readonly values = new Map<string, string>();

  async set(key: string, value: string, options: { NX?: boolean; PX?: number }) {
    void options.PX;
    if (options.NX && this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
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
});
