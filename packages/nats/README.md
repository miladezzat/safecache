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
  onError: (error) => logger.warn({ err: error }, "cache event bus error"),
});

const cache = createCache({ namespace: "app", provider, distributed: { events } });
```

## Delivery Confirmation

By default `publish` is **fire-and-forget** (`confirm: "none"`): lowest latency, but
a broker outage cannot be detected from the publish call. Two confirming modes make
a failed publish observable:

```ts
// At-most-once, but a down connection surfaces an error via onError.
natsEventBus({ client, subject, confirm: "flush" });

// At-least-once: confirming JetStream publish that resolves on a broker PubAck.
natsEventBus({ client, subject, confirm: "jetstream" });
```

`confirm: "flush"` requires the client to implement `flush()`; `confirm: "jetstream"`
requires `jetstream()` and a JetStream-enabled server/stream. A failed confirming
publish is routed to `onError` and, by default, **swallowed** so a degraded broker
never throws into your application. Set `propagateInvalidationErrors: true` to re-throw
a publish failure after notifying (it has no effect with `confirm: "none"`).

## Safety

Cache-side failures on the event-bus hot path — confirming-publish failures,
subscription delivery errors, malformed/foreign payloads (validated with core's
`parseCacheEvent`), and rejecting handlers — are routed to `onError` and then
swallowed. The dispatch loop never throws and the host operation continues as if
the cache were absent. The only way a publish failure propagates is the explicit
`propagateInvalidationErrors` opt-in.

## API

- `natsEventBus`
- `NatsEventBusOptions`
- `NatsPublishConfirm`
- `NatsClientLike`, `NatsJetStreamLike`, `NatsSubscriptionLike`, `NatsPubAck`

## When To Use This

Use this package when cache invalidation events should flow through NATS subjects.

## Production Notes

Use NATS when low-latency service messaging fits your invalidation topology. Confirm delivery guarantees for your deployment mode.

## Related Packages

- `@safecache/core`
- `@safecache/events`
- `@safecache/kafka`
- `@safecache/rabbitmq`

## Documentation

- [Advanced Event Buses](../../docs/advanced-event-buses.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
