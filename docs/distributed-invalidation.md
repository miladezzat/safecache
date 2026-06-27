# Distributed Invalidation

Distributed invalidation broadcasts key and tag changes between Node.js instances. It is required
when each instance has its own memory layer or when invalidation must cross service boundaries.

## Why it matters

Without distributed events, instance A can mutate data and invalidate its own cache while instance B
continues serving an old memory value. SafeCache solves this through the `CacheEventBus` interface.

## Redis Pub/Sub setup

```ts
import { redisPubSub } from "@safecache/pubsub";

const cache = createCache({
  namespace: "app",
  source: "api-1",
  layers: [memoryProvider({ ttl: "30s" }), redisProvider(redis)],
  distributed: {
    events: redisPubSub(redis),
  },
  defaultTtl: "5m",
});
```

`source` identifies the current process so self-originated events can be ignored.

## Event shape

Distributed events include:

```txt
id
type
source
timestamp
namespace
tenant
key
tag
actor
reason
region
```

Event IDs are used for dedupe. Source IDs avoid reprocessing events emitted by the same cache.

## Common mistakes

- Adding a memory layer in multiple processes without an event bus.
- Reusing the same source ID for all instances.
- Assuming Pub/Sub is durable; use Kafka, NATS, RabbitMQ, AWS events, or an outbox when durability is required.
- Forgetting tenant context during invalidation.

## Related packages

- `@safecache/pubsub`
- `@safecache/events`
- `@safecache/kafka`
- `@safecache/nats`
- `@safecache/rabbitmq`
- `@safecache/aws-events`
