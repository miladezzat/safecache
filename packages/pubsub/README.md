# @safecache/pubsub

Redis Pub/Sub event bus for distributed SafeCache invalidation.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/pubsub @safecache/core
```

## Usage

```ts
import { redisPubSub } from "@safecache/pubsub";

const cache = createCache({
  namespace: "app",
  provider,
  distributed: {
    events: redisPubSub(redis),
  },
});
```

## API

- `redisPubSub`
- `RedisPubSubClient`
- `RedisPubSubOptions`

### `RedisPubSubOptions`

- `channel?` — Redis channel name (default `__safecache:events`).
- `onError?` — notifier invoked for every cache-side failure: a `publish` that rejects, an incoming message that fails validation, or a subscribe handler that throws. Defaults to a silent no-op (library code does not log on your behalf). Supply your own to surface these.
- `propagateInvalidationErrors?` — opt-in escape hatch. When `true`, a failed `publish` rejects to the caller instead of being swallowed. Subscribe-side errors (malformed messages, throwing handlers) are never propagated regardless. Default `false`.

## Safety

A cache-side failure must never throw into your application. On this bus:

- A `publish` whose underlying Redis client rejects is caught, routed to `onError`, and swallowed — the host operation continues as if the cache were absent (unless you opt in with `propagateInvalidationErrors`).
- Incoming messages are validated with `parseCacheEvent`; a malformed payload (bad JSON or wrong shape) is routed to `onError` and skipped, never dispatched and never thrown.
- A subscribe handler that throws or rejects is isolated to `onError`, so a faulty handler cannot crash the process via an unhandled rejection.

The only errors that propagate are your own handler/fetcher throwing, or an explicit `propagateInvalidationErrors` opt-in.

## When To Use This

Use this package when multiple Node.js processes need to receive each other's cache invalidation events through Redis.

## Production Notes

### Delivery semantics: at-most-once

Redis Pub/Sub is fire-and-forget and **at-most-once**. A subscriber that is momentarily disconnected — a network blip, a reconnect, or a slow consumer that Redis disconnects for exceeding its output buffer — silently misses every message published during that window. There is no replay, acknowledgement, or backlog. In practice an invalidation can be lost and a stale value served until its TTL elapses.

Treat this bus as best-effort online invalidation, not a durability guarantee. For stronger guarantees use a durable bus (Kafka, RabbitMQ, an outbox, or a cloud event service) when replay or durability is required, and **sign events** (see `distributed.signingSecret`) so subscribers can reject forged or tampered invalidations.

## Related Packages

- `@safecache/core`
- `@safecache/redis`
- `@safecache/locks`

## Documentation

- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [Redis Setup](../../docs/redis-setup.md)
- [SafeCache README](../../README.md)
