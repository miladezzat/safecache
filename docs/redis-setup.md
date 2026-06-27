# Redis Setup

Redis support is optional and provided by separate packages from `@safecache/core`. Use Redis when
cached values or coordination must be shared across multiple Node.js processes.

## Install

```bash
pnpm add @safecache/core @safecache/memory @safecache/redis @safecache/locks @safecache/pubsub
```

Add your Redis client separately, for example `redis` from npm.

## Provider setup

```ts
import { createCache } from "@safecache/core";
import { redisProvider } from "@safecache/redis";

const cache = createCache({
  namespace: "app",
  provider: redisProvider(redis),
  defaultTtl: "5m",
});
```

## Multi-layer setup

Use memory as a fast first layer and Redis as the shared backing layer:

```ts
import { memoryProvider } from "@safecache/memory";
import { redisProvider } from "@safecache/redis";

const cache = createCache({
  namespace: "app",
  layers: [memoryProvider({ ttl: "30s" }), redisProvider(redis)],
  defaultTtl: "5m",
});
```

## Distributed coordination

```ts
import { redisLock } from "@safecache/locks";
import { redisPubSub } from "@safecache/pubsub";

const cache = createCache({
  namespace: "app",
  source: "api-1",
  layers: [memoryProvider({ ttl: "30s" }), redisProvider(redis)],
  distributed: {
    lock: redisLock(redis),
    events: redisPubSub(redis),
  },
  defaultTtl: "5m",
});
```

## Required client shape

The Redis provider expects common Redis methods:

```txt
get
set
del
sAdd
sMembers
sRem
expire
ping
```

The lock adapter expects `set`, `get`, `del`, and optionally `eval` for token-safe release.

## Common mistakes

- Using Redis as the only layer when process-local memory would reduce hot-key latency.
- Sharing one Redis tag prefix across unrelated apps without namespaces.
- Forgetting to configure Pub/Sub when multiple instances have memory layers.
- Using distributed locks without monitoring lock wait or contention.

## Related examples

- [Redis Distributed Example](../examples/redis-distributed/README.md)
