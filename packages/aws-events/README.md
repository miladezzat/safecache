# @safecache/aws-events

AWS event bus adapter for SafeCache distributed cache events.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/aws-events @safecache/core
```

## Usage

```ts
import { awsEventBus } from "@safecache/aws-events";

const events = awsEventBus({
  client: eventBridgeClient,
  eventBusName: "default",
  source: "safecache.app",
  command: (input) => new PutEventsCommand(input),
  // Bridge EventBridge delivery back into CacheEvent dispatch. Hand the adapter
  // the raw EventBridge `detail` (object or JSON string); it validates before
  // dispatching. See "Subscriber bridge contract" below.
  subscribe: async (handler) => subscribeFromYourAwsBridge((record) => handler(record.detail)),
  onError: (error) => logger.warn({ err: error }, "cache event bus error"),
});
```

## Subscriber bridge contract

Unlike the broker transports (Kafka, NATS, RabbitMQ) this adapter does not own an
EventBridge consumer — EventBridge delivers to targets (Lambda, SQS, ...) that you
wire up out-of-band. You therefore supply a `subscribe` bridge, and the adapter
defines a precise `Detail`→`CacheEvent` contract it must satisfy:

1. On `publish`, the adapter sets each entry's `Detail` to `JSON.stringify(event)`
   for a SafeCache `CacheEvent`. EventBridge then envelopes it as the `detail`
   field of the delivered record.
2. Your bridge unwraps that envelope and passes the `detail` value — either the
   parsed object or the raw JSON string — to the `handler` the adapter gives you.
3. The adapter validates every inbound value with core's `parseCacheEvent` before
   dispatch. A malformed or foreign `Detail` (bad JSON, or a payload that is not a
   `CacheEvent`) is routed to `onError` and **skipped** — never dispatched, never
   thrown back into your bridge.
4. Your bridge resolves with an async unsubscribe that tears the delivery down.

## API

- `awsEventBus`
- `AwsEventBusOptions`
- `AwsEventsClientLike`
- `AwsSubscriberBridge`

## When To Use This

Use this package when invalidation events need to cross services through AWS EventBridge or a custom AWS subscriber bridge.

## Production Notes

Use a subscriber bridge that turns AWS events back into SafeCache `CacheEvent` objects. Treat cross-region propagation as eventually consistent.

## Safety

Cache-side failures on the event-bus hot path — a failed `putEvents` publish
(including EventBridge per-entry `FailedEntryCount` failures returned inside a 200
response), a malformed/foreign inbound `Detail` (validated with core's
`parseCacheEvent`), and a rejecting subscriber handler — are routed to `onError`
and then **swallowed**, so a degraded transport never throws into your application
and delivery continues as if the cache were absent. `onError` defaults to a silent
no-op. The only way a publish failure propagates is the explicit
`propagateInvalidationErrors: true` opt-in, which re-throws a publish failure from
`publish` after notifying `onError`.

## Related Packages

- `@safecache/core`
- `@safecache/events`
- `@safecache/kafka`
- `@safecache/nats`
- `@safecache/rabbitmq`

## Documentation

- [Advanced Event Buses](../../docs/advanced-event-buses.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
