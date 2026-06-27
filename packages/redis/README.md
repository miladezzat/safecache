# @safecache/redis

Redis-backed SafeCache provider and Redis tag index.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/redis @safecache/core
```

## Usage

```ts
import { redisProvider } from "@safecache/redis";

const cache = createCache({
  namespace: "app",
  provider: redisProvider(redis),
  defaultTtl: "5m",
});
```

## API

- `redisProvider`
- `RedisProvider`
- `RedisProviderClient`
- `RedisProviderOptions`

## When To Use This

Use this package when Redis should store cached entries and distributed tag metadata.

## Production Notes

Use a Redis client with the required provider and set-operation methods. For multi-instance apps with memory layers, combine this package with `@safecache/pubsub`.

## Related Packages

- `@safecache/core`
- `@safecache/memory`
- `@safecache/locks`
- `@safecache/pubsub`

## Documentation

- [Redis Setup](../../docs/redis-setup.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
