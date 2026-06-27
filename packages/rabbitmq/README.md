# @safecache/rabbitmq

RabbitMQ CacheEventBus adapter for distributed SafeCache invalidation.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/rabbitmq @safecache/core
```

## Usage

```ts
import { rabbitMqEventBus } from "@safecache/rabbitmq";

const events = rabbitMqEventBus({
  channel,
  exchange: "cache.events",
});

const cache = createCache({ namespace: "app", provider, distributed: { events } });
```

## API

- `rabbitMqEventBus`
- `RabbitMqEventBusOptions`

## When To Use This

Use this package when cache invalidation events should flow through RabbitMQ fanout exchanges.

## Production Notes

Use durable exchanges and queues when invalidation delivery must survive restarts.

## Related Packages

- `@safecache/core`
- `@safecache/events`
- `@safecache/kafka`
- `@safecache/nats`

## Documentation

- [Advanced Event Buses](../../docs/advanced-event-buses.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
