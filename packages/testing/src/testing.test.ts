import { describe, expect, test, vi } from "vitest";
import { createTestCache, FakeClock, FakeProvider, MockEventBus } from "./index";

describe("testing utilities", () => {
  test("createTestCache returns a cache with deterministic fake clock", async () => {
    const { cache, clock } = createTestCache({ defaultTtl: "10ms" });
    const fetcher = vi.fn(async () => "value");

    await cache.query({ key: "k", fetcher });
    clock.advance(11);
    await cache.query({ key: "k", fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("FakeProvider and MockEventBus expose deterministic state", async () => {
    const clock = new FakeClock();
    const provider = new FakeProvider(clock);
    const events = new MockEventBus();
    const seen: string[] = [];

    await provider.set("k", "v", { ttlMs: 10 });
    await events.subscribe(async (event) => {
      seen.push(event.type);
    });
    await events.publish({
      id: "1",
      type: "invalidate:key",
      source: "test",
      timestamp: clock.now(),
      namespace: "app",
      key: "k",
    });

    expect(await provider.get("k")).toBe("v");
    expect(seen).toEqual(["invalidate:key"]);
  });
});
