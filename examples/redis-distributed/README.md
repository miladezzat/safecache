# Redis Distributed Example

This example demonstrates a multi-layer distributed SafeCache setup with memory, Redis, Redis
locks, and Redis Pub/Sub.

## What it demonstrates

- memory as a fast first layer
- Redis as the shared backing layer
- Redis locks for distributed stampede prevention
- Redis Pub/Sub for invalidation across instances
- per-instance `source` IDs

## Packages used

```txt
@safecache/core
@safecache/memory
@safecache/redis
@safecache/locks
@safecache/pubsub
```

## Verify the example

```bash
pnpm --filter redis-distributed typecheck
pnpm --filter redis-distributed build
```

## Walkthrough

```ts
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
  });
}
```

Create one cache per app instance and pass a different `source` value to each one, such as
`api-1`, `api-2`, or a process ID.

## Redis client shape

The example type expects the methods used by the provider, lock, and Pub/Sub adapters:

```txt
get
set
del
sAdd
sMembers
sRem
expire
publish
subscribe
unsubscribe
eval
ping
```

`node-redis` can be adapted by passing the regular client for provider/lock methods and a duplicate
client for subscriptions if your application needs separate Pub/Sub connections.

## Expected behavior

- reads check memory first, then Redis
- Redis hits backfill memory
- mutation invalidation publishes events to other instances
- lock acquisition prevents multiple instances from refreshing the same key at once

## Related docs

- [Redis setup](../../docs/redis-setup.md)
- [Distributed invalidation](../../docs/distributed-invalidation.md)
- [Stampede prevention](../../docs/stampede-prevention.md)
