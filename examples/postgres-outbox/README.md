# Postgres Outbox Example

This example demonstrates durable cache invalidation through a Postgres outbox table.

## What it demonstrates

- `cacheOutboxTableSql()`
- `createPostgresOutbox()`
- polling unprocessed outbox rows
- mapping payload keys and tags to SafeCache invalidation

## Packages used

```txt
@safecache/core
@safecache/memory
@safecache/postgres-outbox
```

## Verify the example

```bash
pnpm --filter postgres-outbox typecheck
pnpm --filter postgres-outbox build
```

## Walkthrough

The example exports the table creation SQL:

```ts
export const createTableSql = cacheOutboxTableSql();
```

It also creates an outbox poller:

```ts
const outbox = createPostgresOutbox({ client });

export async function pollOutbox() {
  return outbox.poll(cache);
}
```

## Payload shape

Outbox payloads can include keys, tags, and tenant:

```json
{
  "keys": ["user:1"],
  "tags": ["user:1", "users"],
  "tenant": "tenant_1"
}
```

## Expected behavior

Rows are marked processed only after all invalidations succeed. Failed rows stay unprocessed,
increment retry count, and keep the last error for debugging.

## Related docs

- [Postgres outbox](../../docs/postgres-outbox.md)
- [Tags and invalidation](../../docs/tags-and-invalidation.md)
