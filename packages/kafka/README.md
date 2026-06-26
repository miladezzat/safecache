# @safecache/kafka

Kafka `CacheEventBus` adapter for SafeCache.

```ts
import { kafkaEventBus } from "@safecache/kafka";

const events = kafkaEventBus({ producer, consumer, topic: "cache-events" });
```
