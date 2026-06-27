import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";
import { redisLock, type RedisLockClient } from "@safecache/locks";
import { redisPubSub, type RedisPubSubClient } from "@safecache/pubsub";
import { redisProvider, type RedisProviderClient } from "@safecache/redis";

type RedisClient = RedisProviderClient & RedisLockClient & RedisPubSubClient;

export function createDistributedCache(redis: RedisClient, source: string) {
  return createCache({
    namespace: "redis-distributed-example",
    source,
    layers: [memoryProvider({ ttl: "30s" }), redisProvider(redis)],
    distributed: {
      lock: redisLock(redis),
      events: redisPubSub(redis),
    },
    defaultTtl: "5m",
    safety: {
      failOpen: true,
      preventStampede: true,
    },
  });
}
