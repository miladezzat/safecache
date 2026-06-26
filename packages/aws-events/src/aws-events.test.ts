import { describe, expect, test, vi } from "vitest";
import type { CacheEvent } from "@safecache/core";
import { awsEventBus } from "./index";

const event: CacheEvent = {
  id: "1",
  type: "invalidate:tag",
  source: "test",
  timestamp: 1,
  namespace: "app",
  tag: "users",
};

describe("AWS event bus", () => {
  test("publishes and subscribes through the CacheEventBus interface", async () => {
    let callback: ((event: CacheEvent) => Promise<void>) | undefined;
    const client = { putEvents: vi.fn(async () => {}) };
    const subscriber = vi.fn(async (handler) => {
      callback = handler;
      return async () => {};
    });
    const handler = vi.fn(async () => {});
    const bus = awsEventBus({
      client,
      eventBusName: "cache-events",
      source: "safecache",
      subscribe: subscriber,
    });

    await bus.publish(event);
    await bus.subscribe(handler);
    await callback?.(event);

    expect(client.putEvents).toHaveBeenCalledWith({
      Entries: [
        {
          Detail: JSON.stringify(event),
          DetailType: event.type,
          EventBusName: "cache-events",
          Source: "safecache",
        },
      ],
    });
    expect(handler).toHaveBeenCalledWith(event);
  });
});
