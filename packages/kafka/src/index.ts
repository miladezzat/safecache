import type { CacheEvent, CacheEventBus } from "@safecache/core";

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
  disconnect?(): Promise<unknown>;
}

export interface KafkaEventBusOptions {
  producer: KafkaProducerLike;
  consumer: KafkaConsumerLike;
  topic: string;
  /**
   * Optional error channel. Invoked when an incoming message cannot be parsed
   * as a CacheEvent or when the subscriber handler throws. The offset is always
   * allowed to advance (the error is swallowed) so a poison message cannot stall
   * the partition. When unset, such errors are silently ignored.
   */
  onError?: (error: Error) => void;
}

export function kafkaEventBus(options: KafkaEventBusOptions): CacheEventBus {
  let producerConnected: Promise<unknown> | undefined;
  let consumerConnected: Promise<unknown> | undefined;

  function ensureProducerConnected(): Promise<unknown> {
    producerConnected ??= options.producer.connect?.() ?? Promise.resolve();
    return producerConnected;
  }

  function ensureConsumerConnected(): Promise<unknown> {
    consumerConnected ??= options.consumer.connect?.() ?? Promise.resolve();
    return consumerConnected;
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
      await ensureConsumerConnected();
      await options.consumer.subscribe({ topic: options.topic });
      await options.consumer.run({
        eachMessage: async ({ message }) => {
          if (message.value === null || message.value === undefined) {
            return;
          }
          // Guard parse + dispatch so a malformed/foreign message or a throwing
          // handler does not propagate into kafkajs. Propagating would leave the
          // offset uncommitted and reprocess the poison message forever; instead
          // we record the error and let the offset advance (swallow-and-continue).
          let event: CacheEvent;
          try {
            event = parseCacheEvent(message.value);
          } catch (error) {
            options.onError?.(toError(error));
            return;
          }
          try {
            await handler(event);
          } catch (error) {
            options.onError?.(toError(error));
          }
        },
      });
      return async () => {
        await options.consumer.disconnect?.();
      };
    },
  };
}

function parseCacheEvent(value: Buffer | Uint8Array | string): CacheEvent {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  return JSON.parse(text) as CacheEvent;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
