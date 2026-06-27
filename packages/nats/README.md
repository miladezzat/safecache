# @safecache/nats

NATS CacheEventBus adapter for distributed SafeCache invalidation.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/nats @safecache/core
```

## Usage

```ts
import { natsEventBus } from "@safecache/nats";

const events = natsEventBus({
  client: natsClient,
  subject: "cache.events",
});

const cache = createCache({ namespace: "app", provider, distributed: { events } });
```

## API

- `natsEventBus`
- `NatsEventBusOptions`

## When To Use This

Use this package when cache invalidation events should flow through NATS subjects.

## Related Packages

- `@safecache/core`
- `@safecache/events`
- `@safecache/kafka`
- `@safecache/rabbitmq`

## Documentation

- [Advanced Event Buses](../../docs/advanced-event-buses.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
