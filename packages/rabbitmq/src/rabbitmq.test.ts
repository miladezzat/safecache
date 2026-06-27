import { describe, expect, test, vi } from "vitest";
import type { CacheEvent } from "@safecache/core";
import { rabbitMqEventBus } from "./index";

const event: CacheEvent = {
  id: "1",
  type: "refresh:key",
  source: "test",
  timestamp: 1,
  namespace: "app",
  key: "user:1",
};

/**
 * The synchronous amqplib delivery callback dispatches on the microtask queue,
 * so tests must flush pending microtasks before asserting on the outcome.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RabbitMQ event bus", () => {
  test("publishes and subscribes through the CacheEventBus interface", async () => {
    let consumer: ((message: { content: Buffer } | null) => void) | undefined;
    const channel = {
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => ({ queue: "q1" })),
      bindQueue: vi.fn(async () => {}),
      publish: vi.fn(),
      consume: vi.fn(async (_queue, handler) => {
        consumer = handler;
        return { consumerTag: "ctag" };
      }),
      cancel: vi.fn(async () => {}),
      ack: vi.fn(),
    };
    const handler = vi.fn(async () => {});
    const bus = rabbitMqEventBus({ channel, exchange: "cache.events" });

    await bus.publish(event);
    const unsubscribe = await bus.subscribe(handler);
    const delivery = { content: Buffer.from(JSON.stringify(event)) };
    consumer?.(delivery);
    await flush();
    await unsubscribe();

    expect(channel.publish).toHaveBeenCalledWith(
      "cache.events",
      "",
      Buffer.from(JSON.stringify(event)),
    );
    expect(handler).toHaveBeenCalledWith(event);
    expect(channel.cancel).toHaveBeenCalledWith("ctag");
  });

  test("acks a delivery only after the handler resolves successfully", async () => {
    let consumer: ((message: { content: Buffer } | null) => void) | undefined;
    let resolveHandler: (() => void) | undefined;
    const channel = {
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => ({ queue: "q1" })),
      bindQueue: vi.fn(async () => {}),
      publish: vi.fn(),
      consume: vi.fn(async (_queue, handler, opts) => {
        consumer = handler;
        // Manual-ack mode must be requested so the broker holds the message
        // until we ack it.
        expect(opts).toEqual({ noAck: false });
        return { consumerTag: "ctag" };
      }),
      cancel: vi.fn(async () => {}),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const bus = rabbitMqEventBus({ channel, exchange: "cache.events" });

    await bus.subscribe(handler);
    const delivery = { content: Buffer.from(JSON.stringify(event)) };
    consumer?.(delivery);
    await flush();

    // Handler still pending → no ack yet.
    expect(channel.ack).not.toHaveBeenCalled();

    resolveHandler?.();
    await flush();

    expect(handler).toHaveBeenCalledWith(event);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledWith(delivery);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  test("a throwing handler does not crash, does not ack, routes to onError and nacks", async () => {
    let consumer: ((message: { content: Buffer } | null) => void) | undefined;
    const channel = {
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => ({ queue: "q1" })),
      bindQueue: vi.fn(async () => {}),
      publish: vi.fn(),
      consume: vi.fn(async (_queue, handler) => {
        consumer = handler;
        return { consumerTag: "ctag" };
      }),
      cancel: vi.fn(async () => {}),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const handlerError = new Error("handler boom");
    const handler = vi.fn(async () => {
      throw handlerError;
    });
    const onError = vi.fn();
    const bus = rabbitMqEventBus({ channel, exchange: "cache.events", onError });

    await bus.subscribe(handler);
    const delivery = { content: Buffer.from(JSON.stringify(event)) };

    // The rejection from the handler must not escape the delivery callback.
    expect(() => consumer?.(delivery)).not.toThrow();
    await flush();

    expect(handler).toHaveBeenCalledWith(event);
    // Failed processing → no ack, nack without requeue, error reported.
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledTimes(1);
    expect(channel.nack).toHaveBeenCalledWith(delivery, false, false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(handlerError, delivery);
  });

  test("a thrown cache-side error does NOT break the host consumer (SafeCache guarantee)", async () => {
    let consumer: ((message: { content: Buffer } | null) => void) | undefined;
    const channel = {
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => ({ queue: "q1" })),
      bindQueue: vi.fn(async () => {}),
      publish: vi.fn(),
      consume: vi.fn(async (_queue, handler) => {
        consumer = handler;
        return { consumerTag: "ctag" };
      }),
      cancel: vi.fn(async () => {}),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    // First delivery's handler throws (a cache-side failure); the second must
    // still be processed and acked, proving the consumer keeps running.
    const handler = vi
      .fn<(event: CacheEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error("cache exploded"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const bus = rabbitMqEventBus({ channel, exchange: "cache.events", onError });

    await bus.subscribe(handler);
    const first = { content: Buffer.from(JSON.stringify(event)) };
    const second = { content: Buffer.from(JSON.stringify({ ...event, id: "2" })) };

    expect(() => consumer?.(first)).not.toThrow();
    await flush();
    expect(() => consumer?.(second)).not.toThrow();
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    // The host operation (second delivery) succeeded as if the cache were absent.
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledWith(second);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("requeueOnHandlerError nacks with requeue=true on handler failure", async () => {
    let consumer: ((message: { content: Buffer } | null) => void) | undefined;
    const channel = {
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => ({ queue: "q1" })),
      bindQueue: vi.fn(async () => {}),
      publish: vi.fn(),
      consume: vi.fn(async (_queue, handler) => {
        consumer = handler;
        return { consumerTag: "ctag" };
      }),
      cancel: vi.fn(async () => {}),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const handler = vi.fn(async () => {
      throw new Error("transient");
    });
    const bus = rabbitMqEventBus({
      channel,
      exchange: "cache.events",
      requeueOnHandlerError: true,
    });

    await bus.subscribe(handler);
    const delivery = { content: Buffer.from(JSON.stringify(event)) };
    consumer?.(delivery);
    await flush();

    expect(channel.nack).toHaveBeenCalledWith(delivery, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  test("drops malformed/foreign deliveries without throwing and keeps dispatching good ones", async () => {
    let consumer: ((message: { content: Buffer } | null) => void) | undefined;
    const channel = {
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => ({ queue: "q1" })),
      bindQueue: vi.fn(async () => {}),
      publish: vi.fn(),
      consume: vi.fn(async (_queue, handler) => {
        consumer = handler;
        return { consumerTag: "ctag" };
      }),
      cancel: vi.fn(async () => {}),
      ack: vi.fn(),
      nack: vi.fn(),
    };
    const handler = vi.fn(async () => {});
    const onError = vi.fn();
    const bus = rabbitMqEventBus({ channel, exchange: "cache.events", onError });

    await bus.subscribe(handler);

    const poison = { content: Buffer.from("{not json") };
    const foreign = { content: Buffer.from(JSON.stringify({ hello: "world" })) };
    const good = { content: Buffer.from(JSON.stringify(event)) };

    // A poison/foreign message must never throw out of the delivery callback.
    expect(() => consumer?.(poison)).not.toThrow();
    expect(() => consumer?.(foreign)).not.toThrow();
    // Good deliveries still dispatch after a bad one.
    expect(() => consumer?.(good)).not.toThrow();
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
    // Malformed/foreign messages are nacked (dropped); the good one is acked.
    expect(channel.nack).toHaveBeenCalledTimes(2);
    expect(channel.nack).toHaveBeenCalledWith(poison, false, false);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledWith(good);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
