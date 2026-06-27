# @safecache/pubsub

Redis Pub/Sub event bus for distributed SafeCache invalidation.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/pubsub @safecache/core
```

## Usage

```ts
import { redisPubSub } from "@safecache/pubsub";

const cache = createCache({
  namespace: "app",
  provider,
  distributed: {
    events: redisPubSub(redis),
  },
});
```

## API

- `redisPubSub`
- `RedisPubSubClient`
- `RedisPubSubOptions`

## When To Use This

Use this package when multiple Node.js processes need to receive each other's cache invalidation events through Redis.

## Production Notes

Redis Pub/Sub is not durable. Use it for online instance invalidation; use Kafka, RabbitMQ, AWS events, or an outbox when replay or durability is required.

## Related Packages

- `@safecache/core`
- `@safecache/redis`
- `@safecache/locks`

## Documentation

- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [Redis Setup](../../docs/redis-setup.md)
- [SafeCache README](../../README.md)
