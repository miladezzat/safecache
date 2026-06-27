import { describe, expect, test } from "vitest";
import { valkeyProvider } from "./index";

class FakeValkey {
  readonly values = new Map<string, string | Uint8Array>();
  readonly sets = new Map<string, Set<string>>();
  readonly expires = new Map<string, number>();
  now = 0;

  async get(key: string) {
    if ((this.expires.get(key) ?? Infinity) <= this.now) {
      this.values.delete(key);
      this.expires.delete(key);
      return null;
    }
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string | Uint8Array,
    options?: { PX?: number; expiration?: { type: string; value: number } },
  ) {
    this.values.set(key, value);
    // Accept both the node-redis v6 structured shape ({ expiration: { type: "PX", value } })
    // and the deprecated flat PX option, so the fake stays faithful to the provider.
    const px = options?.expiration?.type === "PX" ? options.expiration.value : options?.PX;
    if (px) {
      this.expires.set(key, this.now + px);
    }
    return "OK";
  }

  async del(...keys: string[]) {
    let count = 0;
    for (const key of keys) {
      if (this.values.delete(key)) {
        count += 1;
      }
      this.expires.delete(key);
      if (this.sets.delete(key)) {
        count += 1;
      }
    }
    return count;
  }

  async sAdd(key: string, members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    members.forEach((member) => set.add(member));
    this.sets.set(key, set);
    return members.length;
  }

  async sMembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }

  async sRem(key: string, members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    members.forEach((member) => set.delete(member));
    return members.length;
  }

  async expire() {
    return 1;
  }

  async ping() {
    return "PONG";
  }
}

describe("valkeyProvider", () => {
  test("uses the Redis-compatible provider contract", async () => {
    const provider = valkeyProvider(new FakeValkey());

    await provider.set("key", "value", { ttlMs: 1000 });
    expect(await provider.get("key")).toBe("value");
    expect(await provider.health()).toMatchObject({ ok: true });
  });

  test("honours TTL expiry through the valkey entrypoint", async () => {
    const valkey = new FakeValkey();
    const provider = valkeyProvider(valkey);

    await provider.set("k", "v", { ttlMs: 10 });
    expect(await provider.get("k")).toBe("v");

    valkey.now = 11;
    expect(await provider.get("k")).toBeNull();
  });

  test("round-trips binary values without corruption", async () => {
    const provider = valkeyProvider(new FakeValkey());

    const binary = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    await provider.set("bin", binary, { ttlMs: 1000 });

    const result = await provider.get("bin");
    expect(result).not.toBeNull();
    const bytes = Uint8Array.from(
      result instanceof Uint8Array ? result : Buffer.from(result as string),
    );
    expect([...bytes]).toEqual([...binary]);
  });

  test("tracks and removes keys by tag through the valkey entrypoint", async () => {
    const provider = valkeyProvider(new FakeValkey());

    await provider.tagIndex.addTags("scope", "key-a", ["users"], 1000);
    await provider.tagIndex.addTags("scope", "key-b", ["users"], 1000);

    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual(["key-a", "key-b"]);

    await provider.tagIndex.removeKey("scope", "key-a", ["users"]);
    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual(["key-b"]);

    await provider.tagIndex.removeTag("scope", "users");
    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual([]);
  });

  test("removes a key without a caller-supplied tag list", async () => {
    const provider = valkeyProvider(new FakeValkey());

    await provider.tagIndex.addTags("scope", "key-a", ["users", "user:key-a"], 1000);
    await provider.tagIndex.removeKey("scope", "key-a");

    expect(await provider.tagIndex.getKeysByTag("scope", "users")).toEqual([]);
    expect(await provider.tagIndex.getKeysByTag("scope", "user:key-a")).toEqual([]);
  });
});
