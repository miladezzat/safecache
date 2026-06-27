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
    };
    const handler = vi.fn(async () => {});
    const bus = rabbitMqEventBus({ channel, exchange: "cache.events" });

    await bus.publish(event);
    const unsubscribe = await bus.subscribe(handler);
    consumer?.({ content: Buffer.from(JSON.stringify(event)) });
    await unsubscribe();

    expect(channel.publish).toHaveBeenCalledWith(
      "cache.events",
      "",
      Buffer.from(JSON.stringify(event)),
    );
    expect(handler).toHaveBeenCalledWith(event);
    expect(channel.cancel).toHaveBeenCalledWith("ctag");
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

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
    expect(channel.nack).toHaveBeenCalledTimes(2);
    expect(channel.nack).toHaveBeenCalledWith(poison, false, false);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
