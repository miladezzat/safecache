# @safecache/events

Event helpers for SafeCache distributed invalidation, dedupe, audit, and source IDs.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/events @safecache/core
```

## Usage

```ts
import { EventDeduper, createCacheEvent, createSourceId } from "@safecache/events";

const source = createSourceId("api");
const event = createCacheEvent({
  type: "invalidate:tag",
  namespace: "app",
  source,
  tag: "users",
  reason: "user updated",
});

const deduper = new EventDeduper();
if (!deduper.seen(event.id)) {
  await bus.publish(event);
}
```

## API

- `createSourceId`
- `createCacheEvent`
- `createCacheAuditLogEntry`
- `EventDeduper`

## When To Use This

Use this package when you need to construct, dedupe, or audit SafeCache events outside the core runtime.

## Production Notes

Event metadata is operational data. Include actor, reason, tenant, and region when manual invalidation or audit trails matter.

## Related Packages

- `@safecache/core`
- `@safecache/pubsub`
- `@safecache/kafka`

## Documentation

- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [Audit Actor Reason Tracking](../../docs/audit-actor-reason-tracking.md)
- [SafeCache README](../../README.md)
