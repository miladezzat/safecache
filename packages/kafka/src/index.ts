import type { CacheEvent, CacheEventBus } from "@safecache/core";

export interface KafkaProducerLike {
  send(input: {
    topic: string;
    messages: Array<{ key?: string; value: string }>;
  }): Promise<unknown>;
}

export interface KafkaConsumerLike {
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
}

export function kafkaEventBus(options: KafkaEventBusOptions): CacheEventBus {
  return {
    async publish(event) {
      await options.producer.send({
        topic: options.topic,
        messages: [{ key: event.id, value: JSON.stringify(event) }],
      });
    },

    async subscribe(handler) {
      await options.consumer.subscribe({ topic: options.topic });
      await options.consumer.run({
        eachMessage: async ({ message }) => {
          if (message.value === null || message.value === undefined) {
            return;
          }
          await handler(parseCacheEvent(message.value));
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
