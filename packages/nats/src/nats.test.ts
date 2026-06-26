import { describe, expect, test, vi } from "vitest";
import type { CacheEvent } from "@safecache/core";
import { natsEventBus } from "./index";

const event: CacheEvent = {
  id: "1",
  type: "invalidate:key",
  source: "test",
  timestamp: 1,
  namespace: "app",
  key: "user:1",
};

describe("NATS event bus", () => {
  test("publishes and subscribes through the CacheEventBus interface", async () => {
    let callback: ((error: unknown, message: { data: Uint8Array }) => void) | undefined;
    const subscription = { unsubscribe: vi.fn() };
    const client = {
      publish: vi.fn(),
      subscribe: vi.fn((_subject, options) => {
        callback = options.callback;
        return subscription;
      }),
    };
    const handler = vi.fn(async () => {});
    const bus = natsEventBus({ client, subject: "cache.events" });

    await bus.publish(event);
    const unsubscribe = await bus.subscribe(handler);
    callback?.(null, { data: new TextEncoder().encode(JSON.stringify(event)) });
    await unsubscribe();

    expect(client.publish).toHaveBeenCalledWith(
      "cache.events",
      new TextEncoder().encode(JSON.stringify(event)),
    );
    expect(handler).toHaveBeenCalledWith(event);
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
