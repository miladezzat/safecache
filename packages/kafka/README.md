# @safecache/kafka

Kafka CacheEventBus adapter for distributed SafeCache invalidation.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/kafka @safecache/core
```

## Usage

```ts
import { kafkaEventBus } from "@safecache/kafka";

const events = kafkaEventBus({
  producer,
  consumer,
  topic: "cache-events",
});

const cache = createCache({ namespace: "app", provider, distributed: { events } });
```

## API

- `kafkaEventBus`
- `KafkaEventBusOptions`

## When To Use This

Use this package when cache invalidation events should flow through Kafka topics.

## Related Packages

- `@safecache/core`
- `@safecache/events`
- `@safecache/nats`
- `@safecache/rabbitmq`

## Documentation

- [Advanced Event Buses](../../docs/advanced-event-buses.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
