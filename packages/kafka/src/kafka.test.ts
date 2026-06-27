import { describe, expect, test, vi } from "vitest";
import type { CacheEvent } from "@safecache/core";
import { kafkaEventBus, type KafkaConsumerLike } from "./index";

const event: CacheEvent = {
  id: "1",
  type: "invalidate:tag",
  source: "test",
  timestamp: 1,
  namespace: "app",
  tag: "users",
};

/** A fake kafkajs consumer that captures the registered `eachMessage`. */
function makeConsumer(): KafkaConsumerLike & {
  eachMessage?: (message: { message: { value: Buffer } }) => Promise<void>;
  connect: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const consumer = {
    eachMessage: undefined as
      | ((message: { message: { value: Buffer } }) => Promise<void>)
      | undefined,
    connect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    run: vi.fn(
      async (opts: { eachMessage: (m: { message: { value: Buffer } }) => Promise<void> }) => {
        consumer.eachMessage = opts.eachMessage;
      },
    ),
    stop: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  return consumer;
}

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

  test("mints a unique per-instance groupId so every instance gets every event (fanout)", async () => {
    const producer = { send: vi.fn(async () => {}) };
    const groupIds: string[] = [];
    const consumers: ReturnType<typeof makeConsumer>[] = [];
    const kafka = {
      consumer: vi.fn((config: { groupId: string }) => {
        groupIds.push(config.groupId);
        const c = makeConsumer();
        consumers.push(c);
        return c;
      }),
    };

    // Two independent instances subscribing with the SAME prefix...
    const busA = kafkaEventBus({ producer, kafka, topic: "cache-events", groupIdPrefix: "svc" });
    const busB = kafkaEventBus({ producer, kafka, topic: "cache-events", groupIdPrefix: "svc" });
    const handlerA = vi.fn(async () => {});
    const handlerB = vi.fn(async () => {});

    await busA.subscribe(handlerA);
    await busB.subscribe(handlerB);

    // ...must end up in DISTINCT consumer groups (the whole point of fanout).
    expect(groupIds).toHaveLength(2);
    expect(groupIds[0]).not.toBe(groupIds[1]);
    expect(groupIds[0]?.startsWith("svc-")).toBe(true);
    expect(groupIds[1]?.startsWith("svc-")).toBe(true);

    // Each consumer independently receives and dispatches the event.
    await consumers[0]?.eachMessage?.({ message: { value: Buffer.from(JSON.stringify(event)) } });
    await consumers[1]?.eachMessage?.({ message: { value: Buffer.from(JSON.stringify(event)) } });
    expect(handlerA).toHaveBeenCalledWith(event);
    expect(handlerB).toHaveBeenCalledWith(event);
  });

  test("honors an explicit groupId override", async () => {
    const producer = { send: vi.fn(async () => {}) };
    let captured: string | undefined;
    const consumer = makeConsumer();
    const kafka = {
      consumer: vi.fn((config: { groupId: string }) => {
        captured = config.groupId;
        return consumer;
      }),
    };
    const bus = kafkaEventBus({
      producer,
      kafka,
      topic: "cache-events",
      groupId: "shared-explicit",
    });

    await bus.subscribe(vi.fn(async () => {}));
    expect(captured).toBe("shared-explicit");
  });

  test("unsubscribe stops and disconnects only this subscription's consumer", async () => {
    const producer = { send: vi.fn(async () => {}) };
    const consumers: ReturnType<typeof makeConsumer>[] = [];
    const kafka = {
      consumer: vi.fn(() => {
        const c = makeConsumer();
        consumers.push(c);
        return c;
      }),
    };
    const bus = kafkaEventBus({ producer, kafka, topic: "cache-events" });

    const unsubA = await bus.subscribe(vi.fn(async () => {}));
    await bus.subscribe(vi.fn(async () => {}));
    await unsubA();

    // Only the first subscription's consumer is torn down (stop then disconnect).
    expect(consumers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(consumers[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(consumers[1]?.stop).not.toHaveBeenCalled();
    expect(consumers[1]?.disconnect).not.toHaveBeenCalled();
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

  test("skips a well-formed JSON message that is not a CacheEvent", async () => {
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

    // Valid JSON but a foreign shape: validated and rejected via core's parser.
    await expect(
      eachMessage?.({ message: { value: Buffer.from(JSON.stringify({ hello: "world" })) } }),
    ).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
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

  test("a cache-side error during message handling never breaks the host operation", async () => {
    // SafeCache guarantee: a failure on the cache side must NEVER throw into the
    // host application. Model the host operation as code that runs right after a
    // cache invalidation event is delivered; even though the cache handler
    // throws, the host operation must still complete.
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
      throw new Error("cache invalidation exploded");
    });
    const errors: Error[] = [];
    const bus = kafkaEventBus({
      producer,
      consumer,
      topic: "cache-events",
      onError: (error) => errors.push(error),
    });

    await bus.subscribe(handler);

    // Deliver the event (cache side throws) then run the host operation.
    let hostCompleted = false;
    await eachMessage?.({ message: { value: Buffer.from(JSON.stringify(event)) } });
    hostCompleted = true; // would be skipped if the cache error had propagated

    expect(hostCompleted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("cache invalidation exploded");
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
    void eachMessage;

    expect(producer.connect).toHaveBeenCalledTimes(1);
    // The legacy single-consumer path connects its consumer once per subscribe.
    expect(consumer.connect).toHaveBeenCalledTimes(1);
  });

  test("reports and (by default) swallows a subscription wiring failure", async () => {
    const producer = { send: vi.fn(async () => {}) };
    const consumer = {
      connect: vi.fn(async () => {
        throw new Error("broker unreachable");
      }),
      subscribe: vi.fn(async () => {}),
      run: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const bus = kafkaEventBus({ producer, consumer, topic: "cache-events", onError });

    // Default fail-open: subscribe resolves with a no-op unsubscribe.
    const unsubscribe = await bus.subscribe(vi.fn(async () => {}));
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(unsubscribe()).resolves.toBeUndefined();
  });

  test("rethrows a wiring failure when propagateInvalidationErrors is set", async () => {
    const producer = { send: vi.fn(async () => {}) };
    const consumer = {
      connect: vi.fn(async () => {
        throw new Error("broker unreachable");
      }),
      subscribe: vi.fn(async () => {}),
      run: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const bus = kafkaEventBus({
      producer,
      consumer,
      topic: "cache-events",
      onError,
      propagateInvalidationErrors: true,
    });

    await expect(bus.subscribe(vi.fn(async () => {}))).rejects.toThrow("broker unreachable");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
