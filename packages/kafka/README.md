# @safecache/kafka

Kafka CacheEventBus adapter for distributed SafeCache invalidation.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/kafka @safecache/core
```

## Usage

Pass the kafkajs `Kafka` client so the adapter can mint a **unique consumer group per instance** — this is what guarantees fanout (every instance receives every invalidation event):

```ts
import { Kafka } from "kafkajs";
import { kafkaEventBus } from "@safecache/kafka";

const kafka = new Kafka({ brokers: ["localhost:9092"] });
const producer = kafka.producer();

const events = kafkaEventBus({
  producer,
  kafka, // adapter mints a fresh, unique-groupId consumer per subscribe
  topic: "cache-events",
  groupIdPrefix: "my-service", // optional; a unique suffix is appended
  onError: (error) => logger.warn({ err: error }, "safecache kafka"),
});

const cache = createCache({ namespace: "app", provider, distributed: { events } });
```

### Fanout vs. a shared consumer group

Kafka load-balances messages **within** a consumer group: only one member of a
group receives each message. Cache invalidation needs the opposite — **every**
instance must invalidate. The adapter therefore generates a unique `groupId`
(`groupIdPrefix` + a random suffix) on every `subscribe`, so each instance forms
its own single-member group and receives every event.

> **Warning:** setting an explicit `groupId` (or supplying a pre-built `consumer`
> whose `groupId` is shared across instances) makes Kafka load-balance events, so
> only ONE instance per group is notified — this **breaks fanout**. Only set
> `groupId` when you deliberately want at-most-once delivery across a group.

### Legacy single-consumer mode

For a single instance you may still pass a pre-built `consumer` instead of
`kafka`. `unsubscribe` then stops and disconnects that consumer.

## Safety

Per the SafeCache guarantee, a cache-side failure never throws into your
application. Malformed/foreign messages are validated via core's
`parseCacheEvent`, reported to `onError`, and skipped (the offset still
advances, so a poison message cannot stall the partition). A throwing subscriber
handler is likewise caught and reported. Errors raised while _establishing_ a
subscription are swallowed by default; set `propagateInvalidationErrors: true`
to rethrow them after they are reported.

## API

- `kafkaEventBus`
- `KafkaEventBusOptions`
- `KafkaClientLike`, `KafkaProducerLike`, `KafkaConsumerLike`

## When To Use This

Use this package when cache invalidation events should flow through Kafka topics.

## Production Notes

Kafka can provide durable event transport, but handlers should still be idempotent and dedupe by event ID.

## Related Packages

- `@safecache/core`
- `@safecache/events`
- `@safecache/nats`
- `@safecache/rabbitmq`

## Documentation

- [Advanced Event Buses](../../docs/advanced-event-buses.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
