import type { CacheEvent, CacheEventBus } from "@safecache/core";

export interface NatsSubscriptionLike {
  unsubscribe(): void;
}

export interface NatsClientLike {
  publish(subject: string, payload: Uint8Array): void;
  subscribe(
    subject: string,
    options: {
      callback(error: unknown, message: { data: Uint8Array }): void;
    },
  ): NatsSubscriptionLike;
}

export interface NatsEventBusOptions {
  client: NatsClientLike;
  subject: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function natsEventBus(options: NatsEventBusOptions): CacheEventBus {
  return {
    async publish(event) {
      options.client.publish(options.subject, encoder.encode(JSON.stringify(event)));
    },

    async subscribe(handler) {
      const subscription = options.client.subscribe(options.subject, {
        callback(error, message) {
          if (error) {
            throw error instanceof Error ? error : new Error(String(error));
          }
          const event = JSON.parse(decoder.decode(message.data)) as CacheEvent;
          void handler(event);
        },
      });
      return async () => {
        subscription.unsubscribe();
      };
    },
  };
}
