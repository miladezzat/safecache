# Postgres Outbox

The Postgres outbox plugin polls cache events from a durable table and invalidates cache safely.

The table shape is:

```txt
id
event_type
payload
created_at
processed_at
retry_count
last_error
```

Payloads can include `keys`, `tags`, and `tenant`.

```ts
import { createPostgresOutbox } from "@safecache/postgres-outbox";

const outbox = createPostgresOutbox({ client });

await outbox.poll(cache);
```

Rows are marked processed only after all mapped invalidations succeed. Failed rows keep
`processed_at = null`, increment `retry_count`, and store `last_error` for retry.
