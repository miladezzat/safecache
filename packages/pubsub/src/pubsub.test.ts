import { describe, expect, test } from "vitest";
import { redisPubSub } from "./index";

class FakeRedisPubSub {
  readonly handlers = new Map<string, Set<(message: string) => void>>();

  async publish(channel: string, message: string) {
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(message);
    }
    return this.handlers.get(channel)?.size ?? 0;
  }

  async subscribe(channel: string, handler: (message: string) => void) {
    const handlers = this.handlers.get(channel) ?? new Set<(message: string) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
  }

  async unsubscribe(channel: string, handler: (message: string) => void) {
    this.handlers.get(channel)?.delete(handler);
  }
}

describe("redisPubSub", () => {
  test("publishes parsed events to subscribers and supports unsubscribe", async () => {
    const redis = new FakeRedisPubSub();
    const bus = redisPubSub(redis, { channel: "cache" });
    const seen: string[] = [];

    const unsubscribe = await bus.subscribe(async (event) => {
      seen.push(event.type);
    });
    await bus.publish({
      id: "1",
      type: "invalidate:key",
      source: "a",
      timestamp: 1,
      namespace: "app",
      key: "k",
    });
    await unsubscribe();
    await bus.publish({
      id: "2",
      type: "invalidate:key",
      source: "a",
      timestamp: 2,
      namespace: "app",
      key: "k",
    });

    expect(seen).toEqual(["invalidate:key"]);
  });
});
