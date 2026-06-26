# Audit, Actor, And Reason Tracking

`CacheEvent` supports optional metadata for audit trails:

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

Fields:

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
