import type { CacheErrorEvent, CacheEvent } from "@safecache/core";
import { describe, expect, test, vi } from "vitest";
import { redisPubSub } from "./index";

class FakeRedisPubSub {
  readonly handlers = new Map<string, Set<(message: string) => void>>();

  async publish(channel: string, message: string) {
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(message);
    }
    return this.handlers.get(channel)?.size ?? 0;
  }

  async subscribe(channel: string, handler: (message: string) => void) {
    const handlers = this.handlers.get(channel) ?? new Set<(message: string) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
  }

  async unsubscribe(channel: string, handler: (message: string) => void) {
    this.handlers.get(channel)?.delete(handler);
  }

  /** Push a raw, unvalidated payload to subscribers (simulates a hostile transport). */
  emitRaw(channel: string, message: string) {
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(message);
    }
  }
}

const sampleEvent: CacheEvent = {
  id: "1",
  type: "invalidate:key",
  source: "a",
  timestamp: 1,
  namespace: "app",
  key: "k",
};

// Let queued microtasks (the handler dispatch) settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("redisPubSub", () => {
  test("publishes parsed events to subscribers and supports unsubscribe", async () => {
    const redis = new FakeRedisPubSub();
    const bus = redisPubSub(redis, { channel: "cache" });
    const seen: string[] = [];

    const unsubscribe = await bus.subscribe(async (event) => {
      seen.push(event.type);
    });
    await bus.publish({ ...sampleEvent, id: "1", timestamp: 1 });
    await flush();
    await unsubscribe();
    await bus.publish({ ...sampleEvent, id: "2", timestamp: 2 });
    await flush();

    expect(seen).toEqual(["invalidate:key"]);
  });

  test("skips malformed messages and routes them to onError without throwing", async () => {
    const redis = new FakeRedisPubSub();
    const errors: CacheErrorEvent[] = [];
    const bus = redisPubSub(redis, { channel: "cache", onError: (e) => errors.push(e) });
    const seen: string[] = [];

    await bus.subscribe(async (event) => {
      seen.push(event.type);
    });

    // Malformed JSON and a well-formed-JSON-but-wrong-shape payload must both be
    // skipped, not dispatched and not thrown.
    expect(() => redis.emitRaw("cache", "not json {")).not.toThrow();
    expect(() => redis.emitRaw("cache", JSON.stringify({ nope: true }))).not.toThrow();
    // A valid event still gets through afterwards.
    redis.emitRaw("cache", JSON.stringify(sampleEvent));
    await flush();

    expect(seen).toEqual(["invalidate:key"]);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.type === "error")).toBe(true);
    expect(errors.every((e) => e.operation === "pubsub.parse")).toBe(true);
  });

  test("isolates a throwing handler so the process does not crash", async () => {
    const redis = new FakeRedisPubSub();
    const errors: CacheErrorEvent[] = [];
    const bus = redisPubSub(redis, { channel: "cache", onError: (e) => errors.push(e) });

    await bus.subscribe(async () => {
      throw new Error("handler boom");
    });

    // The delivery path must not throw synchronously...
    expect(() => redis.emitRaw("cache", JSON.stringify(sampleEvent))).not.toThrow();
    // ...and the async handler rejection must be caught and routed, not surfaced
    // as an unhandled rejection that would crash the host.
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.operation).toBe("pubsub.handler");
    expect(errors[0]?.error.message).toBe("handler boom");
  });

  test("swallows a failing publish and notifies, never breaking the host", async () => {
    const failing = {
      publish: vi.fn(async () => {
        throw new Error("redis down");
      }),
      subscribe: vi.fn(async () => {}),
    };
    const errors: CacheErrorEvent[] = [];
    const bus = redisPubSub(failing, { onError: (e) => errors.push(e) });

    // The core safety guarantee: a cache-side failure must NOT throw into the
    // host. publish resolves even though the underlying client rejected.
    await expect(bus.publish(sampleEvent)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.operation).toBe("pubsub.publish");
    expect(errors[0]?.error.message).toBe("redis down");
  });

  test("propagateInvalidationErrors opt-in re-throws a failing publish", async () => {
    const failing = {
      publish: vi.fn(async () => {
        throw new Error("redis down");
      }),
      subscribe: vi.fn(async () => {}),
    };
    const errors: CacheErrorEvent[] = [];
    const bus = redisPubSub(failing, {
      onError: (e) => errors.push(e),
      propagateInvalidationErrors: true,
    });

    await expect(bus.publish(sampleEvent)).rejects.toThrow("redis down");
    // Still notified even when propagating.
    expect(errors).toHaveLength(1);
  });

  test("default onError is a silent no-op and does not throw on bad input", async () => {
    const redis = new FakeRedisPubSub();
    const bus = redisPubSub(redis, { channel: "cache" });
    await bus.subscribe(async () => {
      throw new Error("boom");
    });

    expect(() => redis.emitRaw("cache", "garbage")).not.toThrow();
    expect(() => redis.emitRaw("cache", JSON.stringify(sampleEvent))).not.toThrow();
    await flush();
  });
});
