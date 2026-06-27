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
    let callback: ((detail: unknown) => Promise<void>) | undefined;
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
    // The bridge delivers the raw Detail (here the JSON string produced by publish).
    await callback?.(JSON.stringify(event));

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

  test("accepts an already-parsed Detail object from the bridge", async () => {
    let callback: ((detail: unknown) => Promise<void>) | undefined;
    const subscriber = vi.fn(async (handler) => {
      callback = handler;
      return async () => {};
    });
    const handler = vi.fn(async () => {});
    const bus = awsEventBus({
      client: { putEvents: vi.fn(async () => {}) },
      eventBusName: "cache-events",
      source: "safecache",
      subscribe: subscriber,
    });

    await bus.subscribe(handler);
    await callback?.(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("routes failed putEvents entries to onError without throwing", async () => {
    const onError = vi.fn();
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
      onError,
    });

    // Default behavior: a publish failure must NOT throw into the host hot path.
    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(client.putEvents).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/ThrottlingException/);
  });

  test("re-throws failed entries only when propagateInvalidationErrors is set", async () => {
    const onError = vi.fn();
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
      onError,
      propagateInvalidationErrors: true,
    });

    await expect(bus.publish(event)).rejects.toThrow(/ThrottlingException/);
    // Even on the opt-in propagate path the error is still reported first.
    expect(onError).toHaveBeenCalledOnce();
  });

  test("routes failed entries on the send path to onError", async () => {
    const onError = vi.fn();
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
      onError,
    });

    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(client.send).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/ValidationException/);
  });

  test("routes a transport rejection to onError without throwing", async () => {
    const onError = vi.fn();
    const client = {
      putEvents: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const bus = awsEventBus({
      client,
      eventBusName: "cache-events",
      source: "safecache",
      onError,
    });

    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/network down/);
  });

  test("resolves when putEvents reports no failed entries", async () => {
    const onError = vi.fn();
    const client = {
      putEvents: vi.fn(async () => ({ FailedEntryCount: 0, Entries: [{ EventId: "abc" }] })),
    };
    const bus = awsEventBus({
      client,
      eventBusName: "cache-events",
      source: "safecache",
      onError,
    });

    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  test("skips a malformed Detail: reports to onError, never dispatches or throws", async () => {
    const onError = vi.fn();
    let callback: ((detail: unknown) => Promise<void>) | undefined;
    const subscriber = vi.fn(async (handler) => {
      callback = handler;
      return async () => {};
    });
    const handler = vi.fn(async () => {});
    const bus = awsEventBus({
      client: { putEvents: vi.fn(async () => {}) },
      eventBusName: "cache-events",
      source: "safecache",
      subscribe: subscriber,
      onError,
    });

    await bus.subscribe(handler);

    // Malformed JSON string.
    await expect(callback?.("not json")).resolves.toBeUndefined();
    // A well-formed object that is not a CacheEvent.
    await expect(callback?.({ hello: "world" })).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  test("a thrown cache error in the handler does NOT break delivery", async () => {
    const onError = vi.fn();
    let callback: ((detail: unknown) => Promise<void>) | undefined;
    const subscriber = vi.fn(async (handler) => {
      callback = handler;
      return async () => {};
    });
    const handler = vi.fn(async () => {
      throw new Error("cache write blew up");
    });
    const bus = awsEventBus({
      client: { putEvents: vi.fn(async () => {}) },
      eventBusName: "cache-events",
      source: "safecache",
      subscribe: subscriber,
      onError,
    });

    await bus.subscribe(handler);

    // The host's delivery bridge must keep running: the rejecting handler is
    // routed to onError and swallowed, never thrown back into the bridge.
    await expect(callback?.(event)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/cache write blew up/);
  });
});
