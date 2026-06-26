import { describe, expect, test } from "vitest";
import { memcachedProvider } from "./index";

class FakeMemcached {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    void ttlSeconds;
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
});
