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
});
