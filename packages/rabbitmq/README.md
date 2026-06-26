# @safecache/rabbitmq

RabbitMQ `CacheEventBus` adapter for SafeCache.

```ts
import { rabbitMqEventBus } from "@safecache/rabbitmq";

const events = rabbitMqEventBus({ channel, exchange: "cache.events" });
```
