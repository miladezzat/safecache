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

  test("rejects when putEvents reports failed entries", async () => {
    const client = {
      putEvents: vi.fn(async () => ({
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }],
      })),
    };
    const bus = awsEventBus({
      client,
      eventBusName: "cache-events",
      source: "safecache",
    });

    await expect(bus.publish(event)).rejects.toThrow(/ThrottlingException/);
    expect(client.putEvents).toHaveBeenCalledOnce();
  });

  test("rejects when the send path reports failed entries", async () => {
    const client = {
      send: vi.fn(async () => ({
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: "ValidationException" }],
      })),
    };
    const bus = awsEventBus({
      client,
      eventBusName: "cache-events",
      source: "safecache",
      command: (input) => input,
    });

    await expect(bus.publish(event)).rejects.toThrow(/ValidationException/);
    expect(client.send).toHaveBeenCalledOnce();
  });

  test("resolves when putEvents reports no failed entries", async () => {
    const client = {
      putEvents: vi.fn(async () => ({ FailedEntryCount: 0, Entries: [{ EventId: "abc" }] })),
    };
    const bus = awsEventBus({
      client,
      eventBusName: "cache-events",
      source: "safecache",
    });

    await expect(bus.publish(event)).resolves.toBeUndefined();
  });
});
