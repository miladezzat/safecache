import { createCache } from "@safecache/core";
import { redisLock, type RedisLockClient } from "@safecache/locks";
import { memoryProvider } from "@safecache/memory";
import { SafeCacheModule, SafeCacheService } from "@safecache/nestjs";
import { redisPubSub, type RedisPubSubClient } from "@safecache/pubsub";
import { redisProvider, type RedisProviderClient } from "@safecache/redis";
import { createClient, type RedisClientType } from "redis";

type SafeCacheRedisClient = RedisProviderClient & RedisLockClient & RedisPubSubClient;

export interface RedisCacheOptions {
  url: string;
  namespace?: string;
  source?: string;
}

export async function createRedisConnection(url: string): Promise<RedisClientType> {
  const client = createClient({ url });
  await client.connect();
  return client;
}

export function adaptRedisClient(client: RedisClientType): SafeCacheRedisClient {
  return {
    get: (key) => client.get(key),
    set: (key, value, options) =>
      client.set(key, typeof value === "string" ? value : Buffer.from(value), options),
    del: (...keys) => client.del(keys),
    sAdd: (key, members) => client.sAdd(key, members),
    sMembers: (key) => client.sMembers(key),
    sRem: (key, members) => client.sRem(key, members),
    expire: (key, seconds) => client.expire(key, seconds),
    ping: () => client.ping(),
    eval: async (script, options) => {
      const result = await client.eval(script, {
        keys: options.keys,
        arguments: options.arguments,
      });

      return typeof result === "number" || typeof result === "string" ? result : null;
    },
    publish: (channel, message) => client.publish(channel, message),
    subscribe: (channel, handler) => client.subscribe(channel, handler),
    unsubscribe: (channel, handler) => client.unsubscribe(channel, handler),
  };
}

export async function createRedisBackedCache(options: RedisCacheOptions) {
  const redis = adaptRedisClient(await createRedisConnection(options.url));

  return createCache({
    namespace: options.namespace ?? "nestjs-example",
    source: options.source ?? "nestjs-api",
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

export const moduleDefinition = SafeCacheModule.forRootAsync({
  useFactory: () =>
    createRedisBackedCache({
      url: process.env.REDIS_URL ?? "redis://localhost:6379",
      namespace: process.env.SAFECACHE_NAMESPACE ?? "nestjs-api",
      source: process.env.HOSTNAME ?? "nestjs-api",
    }),
  // Fail-safe notifier: SafeCache is fail-open, so cache-side faults never reach
  // the request — route them to your logger / Sentry instead of swallowing them.
  onError: (error) => {
    console.error("[safecache] cache degraded:", error.message);
  },
});

// When the cache is built synchronously (no async Redis connection to await),
// register it with `forRoot()` instead. This is the in-memory composition path.
export const memoryModuleDefinition = SafeCacheModule.forRoot({
  cache: createCache({
    namespace: "nestjs-memory",
    layers: [memoryProvider({ ttl: "30s" })],
    defaultTtl: "5m",
    safety: {
      failOpen: true,
      preventStampede: true,
    },
  }),
  onError: (error) => {
    console.error("[safecache] cache degraded:", error.message);
  },
});

export class UsersService {
  constructor(private readonly safeCache: SafeCacheService) {}

  findById(id: string) {
    return this.safeCache.query({
      key: `user:${id}`,
      tags: [`user:${id}`, "users"],
      fetcher: async () => ({ id, name: "Ada" }),
    });
  }
}
