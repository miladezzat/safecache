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

  test("does not throw or leak rejections on malformed messages or rejecting handlers", async () => {
    let callback: ((error: unknown, message: { data: Uint8Array }) => void) | undefined;
    const subscription = { unsubscribe: vi.fn() };
    const client = {
      publish: vi.fn(),
      subscribe: vi.fn((_subject, options) => {
        callback = options.callback;
        return subscription;
      }),
    };
    const errors: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const failure = new Error("handler down");
      const handler = vi.fn(async () => {
        throw failure;
      });
      const bus = natsEventBus({
        client,
        subject: "cache.events",
        onError: (error) => {
          errors.push(error);
        },
      });
      await bus.subscribe(handler);

      // Delivery error from the provider must be routed, not thrown.
      const deliveryError = new Error("provider unavailable");
      expect(() => callback?.(deliveryError, { data: new Uint8Array() })).not.toThrow();

      // Malformed payload must be skipped without throwing and without invoking the handler.
      expect(() => callback?.(null, { data: new TextEncoder().encode("not json") })).not.toThrow();

      // Rejecting handler must not throw synchronously and its rejection must be routed.
      expect(() =>
        callback?.(null, { data: new TextEncoder().encode(JSON.stringify(event)) }),
      ).not.toThrow();

      // Let the detached promise chain settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(errors).toContain(deliveryError);
      expect(errors).toContain(failure);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
