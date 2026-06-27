# @safecache/postgres-outbox

Postgres outbox worker for durable cache invalidation events.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/postgres-outbox @safecache/core
```

## Usage

```ts
import { postgresOutbox } from "@safecache/postgres-outbox";

cache.use(
  postgresOutbox({
    client,
    pollIntervalMs: 1_000,
    pollOnStart: true,
  }),
);
```

## API

- `postgresOutbox`
- `createPostgresOutbox`
- `cacheOutboxTableSql`

## When To Use This

Use this package when database transactions write cache invalidation records that should be retried until processed.

## Related Packages

- `@safecache/core`
- `@safecache/mongodb-streams`

## Documentation

- [Postgres Outbox](../../docs/postgres-outbox.md)
- [Tags And Invalidation](../../docs/tags-and-invalidation.md)
- [SafeCache README](../../README.md)
