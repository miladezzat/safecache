# Advanced Event Buses

Phase 9 adds event bus adapters that preserve the same `CacheEventBus` interface used by Redis
Pub/Sub.

```ts
import { kafkaEventBus } from "@safecache/kafka";

createCache({
  namespace: "app",
  distributed: {
    events: kafkaEventBus({ producer, consumer, topic: "cache-events" }),
  },
});
```

Packages:

```txt
@safecache/kafka
@safecache/nats
@safecache/rabbitmq
@safecache/aws-events
```

All adapters publish serialized `CacheEvent` records and subscribe with
`(event: CacheEvent) => Promise<void>`.
