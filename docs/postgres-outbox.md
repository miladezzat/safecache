# Postgres Outbox

The Postgres outbox plugin polls cache invalidation records from a durable table. It is useful when
database transactions must create invalidation work that can be retried safely.

## Install

```bash
pnpm add @safecache/postgres-outbox @safecache/core
```

## Table shape

```txt
id
event_type
payload
created_at
processed_at
retry_count
last_error
```

Use the helper to create the schema:

```ts
import { cacheOutboxTableSql } from "@safecache/postgres-outbox";

await client.query(cacheOutboxTableSql());
```

## Payload shape

Payloads can include:

```json
{
  "keys": ["user:123"],
  "tags": ["user:123", "users"],
  "tenant": "tenant_1"
}
```

## Polling

```ts
import { createPostgresOutbox } from "@safecache/postgres-outbox";

const outbox = createPostgresOutbox({
  client,
  batchSize: 100,
});

await outbox.poll(cache);
```

Rows are marked processed only after all mapped invalidations succeed. Failed rows keep
`processed_at = null`, increment `retry_count`, and store `last_error` for retry.

## Common mistakes

- Marking rows processed before invalidation succeeds.
- Writing outbox rows outside the database transaction that changed source data.
- Polling too aggressively without backoff.
- Ignoring `last_error` and retry count growth.

## Related example

- [Postgres Outbox Example](../examples/postgres-outbox/README.md)
