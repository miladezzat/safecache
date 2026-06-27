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
  /**
   * Optional sink for subscription-time errors (delivery errors, malformed
   * payloads, or rejecting handlers). When omitted, such errors are ignored;
   * subscribers own their own runtime error handling. The callback itself must
   * never throw — it is invoked from a detached promise chain.
   */
  onError?: (error: unknown) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function natsEventBus(options: NatsEventBusOptions): CacheEventBus {
  return {
    async publish(event) {
      options.client.publish(options.subject, encoder.encode(JSON.stringify(event)));
    },

    async subscribe(handler) {
      const onError = options.onError;
      const subscription = options.client.subscribe(options.subject, {
        callback(error, message) {
          if (error) {
            onError?.(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          let event: CacheEvent;
          try {
            event = JSON.parse(decoder.decode(message.data)) as CacheEvent;
          } catch {
            // Malformed payloads are skipped; never throw from the dispatch loop.
            return;
          }
          void Promise.resolve()
            .then(() => handler(event))
            .catch((cause) => {
              onError?.(cause);
            });
        },
      });
      return async () => {
        subscription.unsubscribe();
      };
    },
  };
}
