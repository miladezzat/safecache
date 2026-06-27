import { randomUUID } from "node:crypto";
import type { CacheEvent, CacheEventBus } from "@safecache/core";
import { parseCacheEvent, toError } from "@safecache/core";

export interface KafkaProducerLike {
  connect?(): Promise<unknown>;
  send(input: {
    topic: string;
    messages: Array<{ key?: string; value: string }>;
  }): Promise<unknown>;
}

export interface KafkaConsumerLike {
  connect?(): Promise<unknown>;
  subscribe(input: { topic: string }): Promise<unknown>;
  run(input: {
    eachMessage(message: {
      message: { value?: Buffer | Uint8Array | string | null };
    }): Promise<void>;
  }): Promise<unknown>;
  /**
   * Optional cooperative stop (kafkajs `Consumer.stop`). When present it is
   * invoked before `disconnect` on unsubscribe so the run loop is halted
   * cleanly before the network connection is torn down.
   */
  stop?(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
}

/**
 * Minimal kafkajs `Kafka` client surface used to mint a fresh consumer per
 * subscription. Supplying this lets the adapter own the `groupId` so it can
 * guarantee fanout (every instance gets a unique group; see
 * {@link KafkaEventBusOptions.groupIdPrefix}).
 */
export interface KafkaClientLike {
  consumer(config: { groupId: string }): KafkaConsumerLike;
}

export interface KafkaEventBusOptions {
  producer: KafkaProducerLike;
  /**
   * kafkajs `Kafka` client. When provided, the adapter mints a *fresh consumer
   * per subscription* with a unique `groupId` so every instance receives every
   * invalidation event (fanout). Prefer this over `consumer` for correct
   * distributed invalidation.
   */
  kafka?: KafkaClientLike;
  /**
   * Pre-built consumer (legacy / single-instance). Used only when `kafka` is not
   * supplied. NOTE: a consumer whose `groupId` is shared across instances will
   * load-balance events, so only ONE instance per group is notified — which
   * breaks fanout. Provide `kafka` (or a per-instance `groupId`) instead.
   */
  consumer?: KafkaConsumerLike;
  topic: string;
  /**
   * Prefix for the auto-generated, per-instance consumer `groupId`. A unique
   * suffix is appended on every subscribe so each instance forms its own
   * single-member group and therefore receives EVERY event (fanout). Only used
   * together with `kafka`. Defaults to `"safecache-cache-events"`.
   */
  groupIdPrefix?: string;
  /**
   * Explicit consumer `groupId` override (used with `kafka`). WARNING: sharing
   * one `groupId` across instances makes Kafka load-balance invalidation events,
   * so only a single instance is notified per event — this BREAKS fanout. Set
   * this only when you deliberately want at-most-once delivery across a group.
   */
  groupId?: string;
  /**
   * Optional error channel. Invoked for every cache-side failure on the hot
   * path: a message that cannot be parsed/validated as a CacheEvent, a throwing
   * subscriber handler, or a failure while wiring up the subscription. The error
   * is swallowed (the host application keeps running as if the cache were absent)
   * and, for messages, the offset is allowed to advance so a poison message
   * cannot stall the partition. Defaults to a silent no-op.
   */
  onError?: (error: Error) => void;
  /**
   * Opt-in: when `true`, errors raised while *establishing* a subscription
   * (connect/subscribe/run) are rethrown to the caller after being reported via
   * `onError`. Per-message errors are ALWAYS swallowed regardless of this flag,
   * so a single bad event can never crash the consumer. Defaults to `false`
   * (SafeCache fail-open: never break the host application).
   */
  propagateInvalidationErrors?: boolean;
}

export function kafkaEventBus(options: KafkaEventBusOptions): CacheEventBus {
  const onError = options.onError ?? (() => {});
  let producerConnected: Promise<unknown> | undefined;

  function ensureProducerConnected(): Promise<unknown> {
    producerConnected ??= options.producer.connect?.() ?? Promise.resolve();
    return producerConnected;
  }

  /**
   * Resolve the consumer for a subscription. With a `kafka` client we mint a
   * fresh, single-member consumer group per subscribe so every instance sees
   * every event. Without one we fall back to the supplied `consumer` (legacy).
   */
  function resolveConsumer(): KafkaConsumerLike {
    if (options.kafka) {
      const prefix = options.groupIdPrefix ?? "safecache-cache-events";
      // A unique suffix guarantees each instance forms its OWN group, so Kafka
      // fans the topic out to all of them instead of load-balancing within one
      // shared group (which would notify only a single instance).
      const groupId = options.groupId ?? `${prefix}-${randomUUID()}`;
      return options.kafka.consumer({ groupId });
    }
    if (options.consumer) {
      return options.consumer;
    }
    throw new Error("kafkaEventBus: provide either `kafka` or `consumer`");
  }

  return {
    async publish(event) {
      await ensureProducerConnected();
      await options.producer.send({
        topic: options.topic,
        messages: [{ key: event.id, value: JSON.stringify(event) }],
      });
    },

    async subscribe(handler) {
      let consumer: KafkaConsumerLike;
      try {
        consumer = resolveConsumer();
        await (consumer.connect?.() ?? Promise.resolve());
        await consumer.subscribe({ topic: options.topic });
        await consumer.run({
          eachMessage: async ({ message }) => {
            if (message.value === null || message.value === undefined) {
              return;
            }
            // Guard parse + dispatch so a malformed/foreign message or a
            // throwing handler can never propagate into kafkajs. Propagating
            // would leave the offset uncommitted and reprocess the poison
            // message forever; instead we report the error and let the offset
            // advance (swallow-and-continue). This is the SafeCache guarantee:
            // a cache-side failure never breaks the host application.
            let event: CacheEvent;
            try {
              event = parseCacheEvent(decode(message.value));
            } catch (error) {
              onError(toError(error));
              return;
            }
            try {
              await handler(event);
            } catch (error) {
              onError(toError(error));
            }
          },
        });
      } catch (error) {
        // A failure while wiring up the subscription is a cache-side failure:
        // report it and (by default) keep the host running as if the cache
        // were absent. Only rethrow when the user explicitly opts in.
        const normalized = toError(error);
        onError(normalized);
        if (options.propagateInvalidationErrors) {
          throw normalized;
        }
        // Return a no-op unsubscribe so the caller's teardown stays uniform.
        return async () => {};
      }
      // Tear down ONLY this subscription's consumer. With the per-subscribe
      // unique-consumer model this never disturbs other subscriptions. Stop the
      // run loop first (when supported), then disconnect.
      return async () => {
        try {
          await (consumer.stop?.() ?? Promise.resolve());
          await (consumer.disconnect?.() ?? Promise.resolve());
        } catch (error) {
          onError(toError(error));
        }
      };
    },
  };
}

function decode(value: Buffer | Uint8Array | string): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}
