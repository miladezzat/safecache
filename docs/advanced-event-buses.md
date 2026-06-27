# Advanced Event Buses

Advanced event bus adapters preserve the same `CacheEventBus` interface used by Redis Pub/Sub.
They are useful when invalidation must cross services, regions, or infrastructure boundaries.

## Packages

```txt
@safecache/kafka
@safecache/nats
@safecache/rabbitmq
@safecache/aws-events
```

## Interface

All adapters publish serialized `CacheEvent` records and subscribe with:

```ts
(event: CacheEvent) => Promise<void>;
```

Example with Kafka:

```ts
import { kafkaEventBus } from "@safecache/kafka";

createCache({
  namespace: "app",
  provider,
  distributed: {
    events: kafkaEventBus({ producer, consumer, topic: "cache-events" }),
  },
});
```

## Choosing a transport

- Use Redis Pub/Sub for simple same-environment invalidation.
- Use Kafka when events need durable topics and replay-friendly infrastructure.
- Use NATS for lightweight service messaging.
- Use RabbitMQ for fanout exchange patterns.
- Use AWS events when invalidation crosses AWS service boundaries.

## Validating untrusted events

Events arrive over the network, so adapters validate them before dispatch using value exports from
`@safecache/core`:

```ts
import { isCacheEvent, parseCacheEvent, toError } from "@safecache/core";
```

- `parseCacheEvent(raw)` — JSON-parses a string (throwing a clear error on malformed JSON), then
  validates the shape. Returns a typed `CacheEvent` or throws `invalid cache event: ...`. Adapters
  (e.g. `@safecache/aws-events`) use this to reject malformed or foreign payloads instead of
  dispatching them.
- `isCacheEvent(value)` — a non-throwing type guard for the same shape check.
- `toError(value)` — normalizes any thrown value into a real `Error`, so notifiers always receive
  an `Error`.

## Signing and verification

When `distributed.signingSecret` is set on `createCache`, outgoing events carry an HMAC-SHA256
`signature` over a canonical serialization, and incoming events with a missing or invalid signature
are dropped. When unset, events are neither signed nor verified. Use a shared secret across
instances when invalidation crosses trust boundaries.

```ts
createCache({
  namespace: "app",
  provider,
  distributed: {
    events: kafkaEventBus({ producer, consumer, topic: "cache-events" }),
    signingSecret: process.env.SAFECACHE_SIGNING_SECRET,
  },
});
```

## Per-adapter error handling

Advanced event-bus adapters follow the SafeCache fail-open contract on the transport hot path. A
failed publish, a malformed inbound event, or a rejecting subscriber handler is routed to the
adapter's `onError` notifier and then swallowed so a degraded transport never throws into the host
application. Adapters such as `@safecache/aws-events` and `@safecache/rabbitmq` accept:

- `onError?: (error: Error, ...) => void` — sink for transport-side failures (defaults to a silent
  no-op; wire it to your logger / Sentry / metrics).
- `propagateInvalidationErrors?: boolean` — opt in to re-throwing a failed `publish` after notifying,
  for callers that require strict delivery. Defaults to `false`.

```ts
import { awsEventBus } from "@safecache/aws-events";

const events = awsEventBus({
  client,
  eventBusName: "cache",
  source: "api-1",
  onError: (error) => logger.warn(error, "cache event transport degraded"),
  propagateInvalidationErrors: false,
});
```

Note that EventBridge returns HTTP 200 even when individual entries fail; the AWS adapter inspects
`FailedEntryCount` and turns a reported failure into an error routed to `onError`, so a dropped
invalidation is not silently treated as success.

## Common mistakes

- Assuming every event bus is durable.
- Forgetting event ID dedupe.
- Reusing the same source ID across processes.
- Publishing cross-region events without accepting eventual consistency.
- Setting a `signingSecret` on only some instances, so signed events are dropped by unconfigured
  peers (or vice versa).
- Running a transport adapter without wiring its `onError` — publish failures then degrade silently.

## Related docs

- [Distributed invalidation](distributed-invalidation.md)
- [Audit, actor, and reason tracking](audit-actor-reason-tracking.md)
- [Multi-region](multi-region.md)
