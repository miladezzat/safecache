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

  test("skips foreign payloads that are valid JSON but not CacheEvents", async () => {
    let callback: ((error: unknown, message: { data: Uint8Array }) => void) | undefined;
    const subscription = { unsubscribe: vi.fn() };
    const client = {
      publish: vi.fn(),
      subscribe: vi.fn((_subject, options) => {
        callback = options.callback;
        return subscription;
      }),
    };
    const errors: Error[] = [];
    const handler = vi.fn(async () => {});
    const bus = natsEventBus({
      client,
      subject: "cache.events",
      onError: (error) => {
        errors.push(error);
      },
    });
    await bus.subscribe(handler);

    // Well-formed JSON but missing required CacheEvent fields → parseCacheEvent throws.
    expect(() =>
      callback?.(null, { data: new TextEncoder().encode(JSON.stringify({ hello: "world" })) }),
    ).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toContain("invalid cache event");
  });

  test('confirm: "flush" round-trips to the broker and routes flush failures', async () => {
    const flushError = new Error("connection closed");
    const flush = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(flushError);
    const errors: Error[] = [];
    const client = {
      publish: vi.fn(),
      flush,
      subscribe: vi.fn(),
    };
    const bus = natsEventBus({
      client,
      subject: "cache.events",
      confirm: "flush",
      onError: (error) => {
        errors.push(error);
      },
    });

    // First publish: flush resolves, no error.
    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(0);

    // Second publish: flush rejects → routed to onError, swallowed (no throw).
    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([flushError]);
  });

  test('confirm: "jetstream" awaits a PubAck and routes publish failures', async () => {
    const publishError = new Error("no responders");
    const jsPublish = vi
      .fn<(subject: string, payload: Uint8Array) => Promise<unknown>>()
      .mockResolvedValueOnce({ stream: "EVENTS", seq: 1 })
      .mockRejectedValueOnce(publishError);
    const errors: Error[] = [];
    const client = {
      publish: vi.fn(),
      jetstream: vi.fn(() => ({ publish: jsPublish })),
      subscribe: vi.fn(),
    };
    const bus = natsEventBus({
      client,
      subject: "cache.events",
      confirm: "jetstream",
      onError: (error) => {
        errors.push(error);
      },
    });

    // First publish: PubAck resolves; the fire-and-forget publish is NOT used.
    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(jsPublish).toHaveBeenCalledTimes(1);
    expect(client.publish).not.toHaveBeenCalled();
    expect(errors).toHaveLength(0);

    // Second publish: PubAck rejects → routed to onError, swallowed.
    await expect(bus.publish(event)).resolves.toBeUndefined();
    expect(errors).toEqual([publishError]);
  });

  test("propagateInvalidationErrors re-throws a confirming-publish failure after notifying", async () => {
    const flushError = new Error("broker outage");
    const errors: Error[] = [];
    const client = {
      publish: vi.fn(),
      flush: vi.fn(async () => {
        throw flushError;
      }),
      subscribe: vi.fn(),
    };
    const bus = natsEventBus({
      client,
      subject: "cache.events",
      confirm: "flush",
      propagateInvalidationErrors: true,
      onError: (error) => {
        errors.push(error);
      },
    });

    await expect(bus.publish(event)).rejects.toBe(flushError);
    // Notified before propagating.
    expect(errors).toEqual([flushError]);
  });

  test("a thrown cache error is routed and never breaks the host operation", async () => {
    // Simulate the host operation: it invalidates (publishes) the cache and then
    // proceeds. The cache broker is down, but the host must complete regardless.
    const brokerOutage = new Error("broker unreachable");
    const errors: Error[] = [];
    const client = {
      publish: vi.fn(),
      flush: vi.fn(async () => {
        throw brokerOutage;
      }),
      subscribe: vi.fn(),
    };
    const bus = natsEventBus({
      client,
      subject: "cache.events",
      confirm: "flush",
      onError: (error) => {
        errors.push(error);
      },
    });

    let hostCompleted = false;
    const runHostOperation = async (): Promise<string> => {
      await bus.publish(event); // cache side fails internally
      hostCompleted = true; // host continues as if the cache were absent
      return "ok";
    };

    await expect(runHostOperation()).resolves.toBe("ok");
    expect(hostCompleted).toBe(true);
    expect(errors).toEqual([brokerOutage]);
  });

  test("default onError is a silent no-op (does not throw on cache-side failure)", async () => {
    const client = {
      publish: vi.fn(),
      flush: vi.fn(async () => {
        throw new Error("down");
      }),
      subscribe: vi.fn(),
    };
    const bus = natsEventBus({ client, subject: "cache.events", confirm: "flush" });

    await expect(bus.publish(event)).resolves.toBeUndefined();
  });
});
