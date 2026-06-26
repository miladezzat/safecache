import type { CacheEvent, CacheEventBus } from "@safecache/core";

export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe?(channel: string, handler: (message: string) => void): Promise<void>;
}

export interface RedisPubSubOptions {
  channel?: string;
}

export function redisPubSub(
  client: RedisPubSubClient,
  options: RedisPubSubOptions = {},
): CacheEventBus {
  const channel = options.channel ?? "__safecache:events";

  return {
    async publish(event) {
      await client.publish(channel, JSON.stringify(event));
    },
    async subscribe(handler) {
      const listener = (message: string) => {
        void Promise.resolve()
          .then(() => handler(JSON.parse(message) as CacheEvent))
          .catch(() => {
            // Subscribers own runtime error handling; invalid messages are ignored here.
          });
      };
      await client.subscribe(channel, listener);
      return async () => {
        await client.unsubscribe?.(channel, listener);
      };
    },
  };
}
