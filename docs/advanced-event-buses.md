# Advanced Event Buses

Advanced event bus adapters preserve the same `CacheEventBus` interface used by Redis Pub/Sub.
They are useful when invalidation must cross services, regions, or infrastructure boundaries.

## Packages

```txt
@safecache/kafka
@safecache/nats
@safecache/rabbitmq
@safecache/aws-events
```

## Interface

All adapters publish serialized `CacheEvent` records and subscribe with:

```ts
(event: CacheEvent) => Promise<void>;
```

Example with Kafka:

```ts
import { kafkaEventBus } from "@safecache/kafka";

createCache({
  namespace: "app",
  provider,
  distributed: {
    events: kafkaEventBus({ producer, consumer, topic: "cache-events" }),
  },
});
```

## Choosing a transport

- Use Redis Pub/Sub for simple same-environment invalidation.
- Use Kafka when events need durable topics and replay-friendly infrastructure.
- Use NATS for lightweight service messaging.
- Use RabbitMQ for fanout exchange patterns.
- Use AWS events when invalidation crosses AWS service boundaries.

## Common mistakes

- Assuming every event bus is durable.
- Forgetting event ID dedupe.
- Reusing the same source ID across processes.
- Publishing cross-region events without accepting eventual consistency.

## Related docs

- [Distributed invalidation](distributed-invalidation.md)
- [Audit, actor, and reason tracking](audit-actor-reason-tracking.md)
- [Multi-region](multi-region.md)
