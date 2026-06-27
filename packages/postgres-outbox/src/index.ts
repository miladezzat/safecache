import type { Cache, CacheErrorEvent, CachePlugin, CachePluginContext } from "@safecache/core";
import { toError } from "@safecache/core";

export interface PostgresQueryResult<TRow> {
  rows: TRow[];
}

export interface PostgresClientLike {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PostgresQueryResult<TRow>>;
}

export interface CacheOutboxRow {
  id: string | number;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
  processed_at: Date | string | null;
  retry_count: number;
  last_error: string | null;
}

export interface CacheOutboxInvalidation {
  keys: string[];
  tags: string[];
  tenant?: string;
}

/**
 * Reason a row could not be delivered. `cache` means a cache-side invalidation
 * threw (retryable); `parse` means the payload itself is malformed and will
 * never succeed (non-retryable → dead-letter immediately).
 */
export type OutboxFailureKind = "cache" | "parse";

/**
 * Notifier callback for outbox worker errors. Receives the same
 * `CacheErrorEvent` shape SafeCache uses internally so a single handler can be
 * wired to logging / metrics for both the cache and this adapter.
 *
 * The worker NEVER throws cache-side failures into the host application: every
 * such error is routed here and the poll loop continues. The notifier is
 * invoked defensively — if it throws, the throw is swallowed so the notifier
 * itself can never break the worker.
 */
export type OutboxErrorNotifier = (event: CacheErrorEvent) => void;

export interface PostgresOutboxOptions {
  client: PostgresClientLike;
  tableName?: string;
  batchSize?: number;
  mapRow?: (row: CacheOutboxRow) => CacheOutboxInvalidation;
  pollIntervalMs?: number;
  pollOnStart?: boolean;
  /**
   * Maximum number of delivery attempts before a row is treated as a poison
   * message. Once `retry_count` reaches this value the row is marked processed
   * (dead-lettered) so it no longer blocks the FIFO head, and it is excluded
   * from future claim queries. Defaults to `undefined`, which preserves the
   * legacy behavior of retrying forever.
   */
  maxRetries?: number;
  /**
   * Upper bound on how long a single row's cache invalidation may run before it
   * is treated as a (retryable) cache failure. Because invalidation now runs
   * OUTSIDE the claim transaction (see {@link createPostgresOutbox}), a slow
   * cache backend can no longer hold Postgres row locks — but a per-row timeout
   * still bounds how long a single poll tick takes. Defaults to `5_000` ms.
   * Set to `0` to disable.
   */
  cacheTimeoutMs?: number;
  /**
   * How long a claimed-but-unfinished row is leased before another worker may
   * re-claim it. The claim transaction stamps `claimed_at = now()` and commits
   * immediately, releasing the row lock; cache invalidation then runs outside
   * any transaction. If this process dies mid-flight, the row becomes claimable
   * again once `claimMs` elapses (at-least-once redelivery). Defaults to
   * `30_000` ms. Should comfortably exceed `cacheTimeoutMs * batchSize`.
   */
  claimMs?: number;
  /**
   * Notifier for worker-side failures (claim/mark DB errors, cache invalidation
   * errors, dead-letter events). Defaults to a silent no-op so library code
   * never logs on its own. Wire this to your logger / Sentry / metrics.
   *
   * Cache-side errors are ALWAYS routed here and never thrown into the host
   * unless {@link PostgresOutboxOptions.propagateInvalidationErrors} is set.
   */
  onError?: OutboxErrorNotifier;
  /**
   * Opt-in: when `true`, a cache-side invalidation error is re-thrown from
   * `poll()` after being routed to {@link PostgresOutboxOptions.onError},
   * instead of being swallowed and retried. Defaults to `false` (swallow +
   * notify + retry), which preserves SafeCache's core safety guarantee: a cache
   * failure must never break the host operation.
   */
  propagateInvalidationErrors?: boolean;
  /**
   * Base delay, in ms, for the exponential backoff applied to the internal poll
   * loop after a failing tick. The delay grows as `pollBackoffBaseMs * 2^n`
   * (capped at {@link PostgresOutboxOptions.pollBackoffMaxMs}) with jitter, and
   * resets to `pollIntervalMs` after a clean tick. Defaults to `pollIntervalMs`.
   */
  pollBackoffBaseMs?: number;
  /**
   * Maximum backoff delay, in ms, for the internal poll loop. Defaults to
   * `30_000` ms.
   */
  pollBackoffMaxMs?: number;
}

export interface PostgresOutboxPollResult {
  rows: number;
  processed: number;
  failed: number;
  /** Rows dead-lettered this poll (poison or unparseable). Subset of `failed`. */
  deadLettered: number;
}

export interface PostgresOutbox {
  poll(cache: Pick<Cache, "invalidate" | "invalidateByTag">): Promise<PostgresOutboxPollResult>;
  plugin(): CachePlugin;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CACHE_TIMEOUT_MS = 5_000;
const DEFAULT_CLAIM_MS = 30_000;
const DEFAULT_POLL_BACKOFF_MAX_MS = 30_000;

export function cacheOutboxTableSql(tableName = "cache_outbox"): string {
  const table = quoteIdentifier(tableName);
  return `
create table if not exists ${table} (
  id uuid primary key,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  claimed_at timestamptz,
  retry_count integer not null default 0,
  last_error text
);
-- Additive for tables created before the claim-then-dispatch lease existed.
alter table ${table} add column if not exists claimed_at timestamptz;
create index if not exists ${tableName}_unprocessed_idx
  on ${table} (created_at)
  where processed_at is null;
`.trim();
}

export function mapPostgresOutboxRow(row: CacheOutboxRow): CacheOutboxInvalidation {
  const payload = parsePayload(row.payload);
  const keys = arrayOfStrings(payload.keys ?? payload.key);
  const tags = arrayOfStrings(payload.tags ?? payload.tag);
  const tenant = typeof payload.tenant === "string" ? payload.tenant : undefined;

  return {
    keys,
    tags,
    ...(tenant ? { tenant } : {}),
  };
}

/**
 * Thrown internally when a row's payload cannot be parsed. Surfaces a distinct
 * signal so the worker dead-letters the row (it can never succeed) rather than
 * retrying it like a transient cache failure.
 */
class OutboxParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutboxParseError";
  }
}

export function createPostgresOutbox(options: PostgresOutboxOptions): PostgresOutbox {
  const table = quoteIdentifier(options.tableName ?? "cache_outbox");
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const mapRow = options.mapRow ?? mapPostgresOutboxRow;
  const maxRetries = options.maxRetries;
  const cacheTimeoutMs = options.cacheTimeoutMs ?? DEFAULT_CACHE_TIMEOUT_MS;
  const claimMs = options.claimMs ?? DEFAULT_CLAIM_MS;
  const propagate = options.propagateInvalidationErrors ?? false;
  const notify = makeNotifier(options.onError);

  // Guards a single outbox instance so overlapping interval ticks (or a
  // pollOnStart tick that overruns the first interval) never run concurrently
  // against the same connection.
  let inFlight = false;

  const self: PostgresOutbox = {
    async poll(cache) {
      if (inFlight) {
        return { rows: 0, processed: 0, failed: 0, deadLettered: 0 };
      }
      inFlight = true;
      try {
        return await claimAndDispatch(cache);
      } finally {
        inFlight = false;
      }
    },

    plugin() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;

      const baseIntervalMs = options.pollIntervalMs;
      const backoffBaseMs = options.pollBackoffBaseMs ?? baseIntervalMs ?? 0;
      const backoffMaxMs = options.pollBackoffMaxMs ?? DEFAULT_POLL_BACKOFF_MAX_MS;

      return {
        name: "safecache-postgres-outbox",

        setup(ctx: CachePluginContext) {
          if (options.pollOnStart) {
            // Surface a pollOnStart failure through the notifier instead of an
            // unobserved rejected promise; the scheduled loop (if any) carries
            // on independently with its own backoff.
            void thisPoll(ctx);
          }
          if (baseIntervalMs) {
            scheduleNext(ctx, baseIntervalMs);
          }
        },

        async shutdown() {
          stopped = true;
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        },
      };

      // Self-rescheduling setTimeout chain (instead of setInterval) so a slow
      // tick can never let the next tick fire before the previous finished —
      // overlapping ticks are also guarded by `inFlight` in poll(). Repeated
      // failures back off exponentially with jitter; a clean tick resets it.
      function scheduleNext(ctx: CachePluginContext, delayMs: number): void {
        if (stopped) {
          return;
        }
        timer = setTimeout(() => {
          void runTick(ctx);
        }, delayMs);
        // Avoid keeping the event loop alive solely for the poll timer.
        if (typeof timer === "object" && typeof timer.unref === "function") {
          timer.unref();
        }
      }

      async function runTick(ctx: CachePluginContext): Promise<void> {
        if (stopped || !baseIntervalMs) {
          return;
        }
        const failed = await thisPoll(ctx);
        if (stopped) {
          return;
        }
        if (failed) {
          consecutiveFailures += 1;
          const backoff = Math.min(backoffBaseMs * 2 ** (consecutiveFailures - 1), backoffMaxMs);
          // Full jitter: random in [0, backoff] keeps competing workers from
          // retrying in lockstep.
          scheduleNext(ctx, baseIntervalMs + Math.floor(Math.random() * backoff));
        } else {
          consecutiveFailures = 0;
          scheduleNext(ctx, baseIntervalMs);
        }
      }

      // Returns true when the tick failed (used to drive backoff). A poll
      // failure is the only thing that ever propagates here — per-row cache
      // failures are swallowed inside claimAndDispatch and never bubble up
      // unless propagateInvalidationErrors is set.
      async function thisPoll(ctx: CachePluginContext): Promise<boolean> {
        try {
          await self.poll(ctx.cache);
          return false;
        } catch (error) {
          const errorEvent: CacheErrorEvent = {
            type: "error",
            operation: "postgres-outbox",
            error: toError(error),
          };
          ctx.emit(errorEvent);
          notify(errorEvent);
          return true;
        }
      }
    },
  };

  // Tracks consecutive failing ticks across the setTimeout chain for backoff.
  let consecutiveFailures = 0;

  /**
   * Claim-then-dispatch. Step 1 claims a batch inside a short transaction
   * (FOR UPDATE SKIP LOCKED + stamp `claimed_at`) and commits immediately, so
   * Postgres row locks are NOT held across the cache round-trips. Step 2 runs
   * the cache invalidation OUTSIDE any transaction. Step 3 marks each row with
   * its own autocommit statement, so a mark failure on one row never rolls back
   * bookkeeping for its siblings.
   *
   * Delivery is AT-LEAST-ONCE: if this process dies between invalidating a row
   * and marking it processed, the claim lease expires after `claimMs` and the
   * row is re-claimed and re-invalidated (a duplicate, idempotent delivery).
   */
  async function claimAndDispatch(
    cache: Pick<Cache, "invalidate" | "invalidateByTag">,
  ): Promise<PostgresOutboxPollResult> {
    const rows = await claimBatch();

    let processed = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const row of rows) {
      // Phase A: map + invalidate (the cache-side hot path). A throw here is
      // either a non-retryable parse failure or a (retryable) cache failure.
      let invalidation: CacheOutboxInvalidation;
      try {
        invalidation = safeMapRow(row);
        await runInvalidation(cache, invalidation);
      } catch (error) {
        failed += 1;
        const parseError = error instanceof OutboxParseError;
        const exhausted = maxRetries !== undefined && row.retry_count + 1 >= maxRetries;
        const dead = parseError || exhausted;

        // (2) Route every cache-side error to the notifier so a degraded cache
        // is observable. The host operation (poll) continues regardless.
        notify({
          type: "error",
          operation: "postgres-outbox:invalidate",
          error: toError(error),
          ...(row.id !== undefined ? { key: String(row.id) } : {}),
        });

        // Bookkeeping is best-effort and isolated per row: a DB hiccup while
        // recording the failure must not abort the rest of the batch (the lease
        // simply expires and the row is retried). Surface it via the notifier.
        try {
          if (dead) {
            await markDeadLettered(options.client, table, row.id, errorMessage(error));
            deadLettered += 1;
          } else {
            await markFailed(options.client, table, row.id, errorMessage(error));
          }
        } catch (markError) {
          notify({
            type: "error",
            operation: "postgres-outbox:mark",
            error: toError(markError),
          });
        }

        // Dead-lettered (poison / unparseable) rows are otherwise silently
        // dropped — emit a distinct, observable signal via the notifier.
        if (dead) {
          notify({
            type: "error",
            operation: parseError
              ? "postgres-outbox:dead-letter:parse"
              : "postgres-outbox:dead-letter",
            error: toError(error),
          });
        }

        // (3) Cache-side errors are swallowed by default (core safety
        // guarantee). Parse errors are never retryable, so they never
        // propagate. Only a genuine cache failure honors the explicit opt-in.
        if (propagate && !parseError) {
          throw toError(error);
        }
        continue;
      }

      // Phase B: mark the row processed. The side-effect already succeeded, so a
      // failure here must NOT bump retry_count or dead-letter the row — leave it
      // claimed and let the lease expire for an at-least-once redelivery. Report
      // the bookkeeping failure but keep processing the rest of the batch.
      try {
        await markProcessed(options.client, table, row.id);
        processed += 1;
      } catch (markError) {
        failed += 1;
        notify({
          type: "error",
          operation: "postgres-outbox:mark",
          error: toError(markError),
        });
      }
    }

    return {
      rows: rows.length,
      processed,
      failed,
      deadLettered,
    };
  }

  async function claimBatch(): Promise<CacheOutboxRow[]> {
    await options.client.query("begin");
    try {
      const result = await options.client.query<CacheOutboxRow>(
        claimSql(table, maxRetries),
        claimParams(batchSize, maxRetries, claimMs),
      );
      await options.client.query("commit");
      return result.rows;
    } catch (error) {
      await rollback(options.client);
      throw error;
    }
  }

  function safeMapRow(row: CacheOutboxRow): CacheOutboxInvalidation {
    try {
      return mapRow(row);
    } catch (error) {
      // A malformed payload (e.g. invalid JSON) can never succeed on retry —
      // signal it distinctly so the caller dead-letters instead of retrying.
      throw new OutboxParseError(
        `failed to parse outbox payload for row ${String(row.id)}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async function runInvalidation(
    cache: Pick<Cache, "invalidate" | "invalidateByTag">,
    invalidation: CacheOutboxInvalidation,
  ): Promise<void> {
    const work = applyOutboxInvalidation(cache, invalidation);
    if (cacheTimeoutMs > 0) {
      await withTimeout(work, cacheTimeoutMs);
    } else {
      await work;
    }
  }

  return self;
}

export function postgresOutbox(options: PostgresOutboxOptions): CachePlugin {
  return createPostgresOutbox(options).plugin();
}

async function applyOutboxInvalidation(
  cache: Pick<Cache, "invalidate" | "invalidateByTag">,
  invalidation: CacheOutboxInvalidation,
): Promise<void> {
  const tenantOptions = { tenant: invalidation.tenant };
  for (const key of unique(invalidation.keys)) {
    await cache.invalidate(key, tenantOptions);
  }
  for (const tag of unique(invalidation.tags)) {
    await cache.invalidateByTag(tag, tenantOptions);
  }
}

/**
 * Reject if `work` has not settled within `timeoutMs`. The underlying promise
 * is allowed to keep running (we cannot cancel it), but the caller treats the
 * timeout as a retryable cache failure.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cache invalidation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === "object" && typeof timer.unref === "function") {
      timer.unref();
    }
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toError(error));
      },
    );
  });
}

/**
 * Wrap a user-supplied notifier so it can never throw into the worker, and
 * default to a silent no-op (library code does not log on its own).
 */
function makeNotifier(onError: OutboxErrorNotifier | undefined): OutboxErrorNotifier {
  if (!onError) {
    return () => {};
  }
  return (event) => {
    try {
      onError(event);
    } catch {
      // A throwing notifier must never break the worker.
    }
  };
}

function claimSql(table: string, maxRetries: number | undefined): string {
  // Re-claimable when unprocessed AND (never claimed OR the claim lease has
  // expired). `claimedParam` is the lease boundary computed by the caller.
  const claimedParam = "$2";
  const capFilter = maxRetries === undefined ? "" : "\n  and retry_count < $3";
  return `with claimed as (
  select id
  from ${table}
  where processed_at is null
    and (claimed_at is null or claimed_at < ${claimedParam})${capFilter}
  order by created_at asc
  limit $1
  for update skip locked
)
update ${table} as o
set claimed_at = now()
from claimed
where o.id = claimed.id
returning o.id, o.event_type, o.payload, o.created_at, o.processed_at, o.retry_count, o.last_error`;
}

function claimParams(
  batchSize: number,
  maxRetries: number | undefined,
  claimMs: number,
): unknown[] {
  // Lease boundary: rows claimed before this instant are reclaimable.
  const leaseBoundary = new Date(Date.now() - claimMs);
  return maxRetries === undefined
    ? [batchSize, leaseBoundary]
    : [batchSize, leaseBoundary, maxRetries];
}

async function rollback(client: PostgresClientLike): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // Ignore rollback failures; the original error is surfaced to the caller.
  }
}

async function markProcessed(
  client: PostgresClientLike,
  table: string,
  id: string | number,
): Promise<void> {
  await client.query(
    `update ${table}
set processed_at = now(), claimed_at = null, last_error = null
where id = $1`,
    [id],
  );
}

async function markDeadLettered(
  client: PostgresClientLike,
  table: string,
  id: string | number,
  error: string,
): Promise<void> {
  // Mark the poison row processed so it stops blocking the FIFO head, while
  // preserving the failure context in last_error for operators to inspect.
  await client.query(
    `update ${table}
set processed_at = now(), claimed_at = null, retry_count = retry_count + 1, last_error = $2
where id = $1`,
    [id, error],
  );
}

async function markFailed(
  client: PostgresClientLike,
  table: string,
  id: string | number,
  error: string,
): Promise<void> {
  // Release the claim immediately so the row is retried on the next poll rather
  // than waiting out the full lease.
  await client.query(
    `update ${table}
set claimed_at = null, retry_count = retry_count + 1, last_error = $2
where id = $1`,
    [id, error],
  );
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    const parsed = JSON.parse(payload) as unknown;
    return isRecord(parsed) ? parsed : {};
  }
  return isRecord(payload) ? payload : {};
}

function arrayOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
