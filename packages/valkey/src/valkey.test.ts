import { describe, expect, test } from "vitest";
import { valkeyProvider } from "./index";

class FakeValkey {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }

  async del(...keys: string[]) {
    for (const key of keys) {
      this.values.delete(key);
      this.sets.delete(key);
    }
    return keys.length;
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
});
