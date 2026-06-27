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
    // Cache failures never throw into your app — wire this to your logger/metrics.
    onError: (event) => logger.warn(event.operation, event.error),
  }),
);
```

## API

- `postgresOutbox`
- `createPostgresOutbox`
- `cacheOutboxTableSql`

## Schema

`cacheOutboxTableSql()` provisions the `cache_outbox` table, including a
`claimed_at timestamptz` column used by the claim lease (see below). It is
emitted as `alter table ... add column if not exists`, so it is safe to re-run
against tables created by an earlier version of this package.

## Delivery Model: Claim-Then-Dispatch (At-Least-Once)

Each poll runs in three phases:

1. **Claim** — a short transaction selects a batch with
   `for update skip locked`, stamps `claimed_at = now()`, and **commits
   immediately**. Postgres row locks are therefore _not_ held while the cache is
   being invalidated, so a slow or unreachable cache can no longer pin
   connections and exhaust the pool.
2. **Dispatch** — cache invalidation runs **outside** any transaction, bounded
   per row by `cacheTimeoutMs`.
3. **Mark** — each row is finalized with its own statement (`processed` /
   retry / dead-letter), so a write failure on one row never rolls back
   bookkeeping for its siblings.

Delivery is **at-least-once**. If the process dies between invalidating a row
and marking it processed, the claim lease expires after `claimMs` and the row is
re-claimed and **re-invalidated**. A row whose side-effect succeeded but whose
mark write later failed is likewise redelivered. **Make invalidations
idempotent** (re-deleting an already-deleted key is a no-op, which they are in
SafeCache).

## Options

| Option                                   | Default                     | Purpose                                                                                                       |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `batchSize`                              | `100`                       | Rows claimed per poll. With `cacheTimeoutMs`, bounds worst-case poll duration (`batchSize * cacheTimeoutMs`). |
| `cacheTimeoutMs`                         | `5_000`                     | Per-row cache invalidation timeout. `0` disables.                                                             |
| `claimMs`                                | `30_000`                    | Claim lease before another worker may re-claim. Should exceed `batchSize * cacheTimeoutMs`.                   |
| `maxRetries`                             | `undefined`                 | Attempts before a poison row is dead-lettered. Unset = retry forever.                                         |
| `onError`                                | silent no-op                | Notifier for all worker-side errors (see Safety).                                                             |
| `propagateInvalidationErrors`            | `false`                     | Opt-in: re-throw a cache failure from `poll()` after notifying.                                               |
| `pollIntervalMs` / `pollOnStart`         | —                           | Drive the internal poll loop.                                                                                 |
| `pollBackoffBaseMs` / `pollBackoffMaxMs` | `pollIntervalMs` / `30_000` | Exponential backoff with jitter after a failing tick.                                                         |

## Safety Guarantee

A failure on the **cache** side never throws into your application. In the poll
hot path every cache-side error is caught, routed to `onError`, and the worker
continues as if the cache were absent. The notifier defaults to a silent no-op
(library code does not log on its own) and is invoked defensively — a throwing
notifier can never break the worker. The only errors that propagate are your own
DB client throwing and, if you opt in, `propagateInvalidationErrors`.

Dead-lettered rows (poison messages and unparseable payloads) are not silently
dropped: each emits a distinct, observable `onError` event
(`postgres-outbox:dead-letter` / `postgres-outbox:dead-letter:parse`). A
malformed JSON payload is treated as a non-retryable dead-letter, never burning
the retry budget on an error that can never succeed.

The internal poll loop self-reschedules with `setTimeout` (not `setInterval`)
and an in-flight guard, so a slow tick can never let ticks pile up or drift.

## When To Use This

Use this package when database transactions write cache invalidation records that should be retried until processed.

## Production Notes

Write outbox rows in the same transaction as the data change. Monitor retry counts and `last_error` for stuck invalidations. Keep `claimMs` comfortably above `batchSize * cacheTimeoutMs` so an in-progress batch is never re-claimed by a sibling worker before it finishes.

## Related Packages

- `@safecache/core`
- `@safecache/mongodb-streams`

## Documentation

- [Postgres Outbox](../../docs/postgres-outbox.md)
- [Tags And Invalidation](../../docs/tags-and-invalidation.md)
- [SafeCache README](../../README.md)
