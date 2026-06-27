# Audit, Actor, And Reason Tracking

`CacheEvent` supports optional metadata for audit trails and invalidation debugging.

## Event metadata

```txt
source
actor
reason
region
tenant
key
tag
timestamp
```

`source` identifies the process or service that emitted the event. `actor` identifies the user,
job, or system principal that caused it. `reason` explains why the event exists.

## Create an event

```ts
import { createCacheAuditLogEntry, createCacheEvent } from "@safecache/events";

const event = createCacheEvent({
  type: "invalidate:tag",
  namespace: "app",
  source: "api",
  tag: "users",
  actor: "user:123",
  reason: "profile update",
  region: "us-east-1",
});

const audit = createCacheAuditLogEntry(event);
```

## When to include metadata

Use metadata for manual invalidations, background jobs, admin tools, and multi-region event flows.
It helps answer:

- who caused this invalidation
- which service emitted it
- which tenant or region was affected
- why a hot tag was invalidated

## Common mistakes

- Logging only keys without reason or actor.
- Using user-provided reason text without sanitizing downstream logs.
- Treating audit metadata as authorization.
- Forgetting to propagate tenant and region in manual operations.

## Related packages

- `@safecache/events`
- `@safecache/cli`
- `@safecache/dashboard`
