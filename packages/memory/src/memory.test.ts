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
});
