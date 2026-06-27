import { describe, expect, test, vi } from "vitest";
import type { CacheEvent } from "@safecache/core";
import { kafkaEventBus } from "./index";

const event: CacheEvent = {
  id: "1",
  type: "invalidate:tag",
  source: "test",
  timestamp: 1,
  namespace: "app",
  tag: "users",
};

describe("Kafka event bus", () => {
  test("publishes and subscribes through the CacheEventBus interface", async () => {
    let eachMessage: ((message: { message: { value: Buffer } }) => Promise<void>) | undefined;
    const producer = { send: vi.fn(async () => {}) };
    const consumer = {
      subscribe: vi.fn(async () => {}),
      run: vi.fn(async (options) => {
        eachMessage = options.eachMessage;
      }),
      disconnect: vi.fn(async () => {}),
    };
    const handler = vi.fn(async () => {});
    const bus = kafkaEventBus({ producer, consumer, topic: "cache-events" });

    await bus.publish(event);
    const unsubscribe = await bus.subscribe(handler);
    await eachMessage?.({ message: { value: Buffer.from(JSON.stringify(event)) } });
    await unsubscribe();

    expect(producer.send).toHaveBeenCalledWith({
      topic: "cache-events",
      messages: [{ key: "1", value: JSON.stringify(event) }],
    });
    expect(consumer.subscribe).toHaveBeenCalledWith({ topic: "cache-events" });
    expect(handler).toHaveBeenCalledWith(event);
    expect(consumer.disconnect).toHaveBeenCalledTimes(1);
  });

  test("skips a malformed message without throwing and still dispatches good ones", async () => {
    let eachMessage: ((message: { message: { value: Buffer } }) => Promise<void>) | undefined;
    const producer = { send: vi.fn(async () => {}) };
    const consumer = {
      subscribe: vi.fn(async () => {}),
      run: vi.fn(async (options) => {
        eachMessage = options.eachMessage;
      }),
      disconnect: vi.fn(async () => {}),
    };
    const handler = vi.fn(async () => {});
    const onError = vi.fn();
    const bus = kafkaEventBus({ producer, consumer, topic: "cache-events", onError });

    await bus.subscribe(handler);

    // A poison message must not propagate into kafkajs (which would stall the
    // partition by leaving the offset uncommitted).
    await expect(
      eachMessage?.({ message: { value: Buffer.from("not-json{") } }),
    ).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);

    // A subsequent good message is still dispatched.
    await eachMessage?.({ message: { value: Buffer.from(JSON.stringify(event)) } });
    expect(handler).toHaveBeenCalledWith(event);
  });

  test("swallows a throwing handler so the offset can advance", async () => {
    let eachMessage: ((message: { message: { value: Buffer } }) => Promise<void>) | undefined;
    const producer = { send: vi.fn(async () => {}) };
    const consumer = {
      subscribe: vi.fn(async () => {}),
      run: vi.fn(async (options) => {
        eachMessage = options.eachMessage;
      }),
      disconnect: vi.fn(async () => {}),
    };
    const handler = vi.fn(async () => {
      throw new Error("handler boom");
    });
    const onError = vi.fn();
    const bus = kafkaEventBus({ producer, consumer, topic: "cache-events", onError });

    await bus.subscribe(handler);

    await expect(
      eachMessage?.({ message: { value: Buffer.from(JSON.stringify(event)) } }),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(event);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("connects the producer and consumer once before use", async () => {
    let eachMessage: ((message: { message: { value: Buffer } }) => Promise<void>) | undefined;
    const producer = { connect: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    const consumer = {
      connect: vi.fn(async () => {}),
      subscribe: vi.fn(async () => {}),
      run: vi.fn(async (options) => {
        eachMessage = options.eachMessage;
      }),
      disconnect: vi.fn(async () => {}),
    };
    const handler = vi.fn(async () => {});
    const bus = kafkaEventBus({ producer, consumer, topic: "cache-events" });

    await bus.publish(event);
    await bus.publish(event);
    await bus.subscribe(handler);
    await bus.subscribe(handler);
    void eachMessage;

    expect(producer.connect).toHaveBeenCalledTimes(1);
    expect(consumer.connect).toHaveBeenCalledTimes(1);
  });
});
