import type { Cache, CachePlugin, CachePluginContext } from "@safecache/core";

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

export interface PostgresOutboxOptions {
  client: PostgresClientLike;
  tableName?: string;
  batchSize?: number;
  mapRow?: (row: CacheOutboxRow) => CacheOutboxInvalidation;
  pollIntervalMs?: number;
  pollOnStart?: boolean;
}

export interface PostgresOutboxPollResult {
  rows: number;
  processed: number;
  failed: number;
}

export interface PostgresOutbox {
  poll(cache: Pick<Cache, "invalidate" | "invalidateByTag">): Promise<PostgresOutboxPollResult>;
  plugin(): CachePlugin;
}

export function cacheOutboxTableSql(tableName = "cache_outbox"): string {
  const table = quoteIdentifier(tableName);
  return `
create table if not exists ${table} (
  id uuid primary key,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  retry_count integer not null default 0,
  last_error text
);
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

export function createPostgresOutbox(options: PostgresOutboxOptions): PostgresOutbox {
  const table = quoteIdentifier(options.tableName ?? "cache_outbox");
  const batchSize = options.batchSize ?? 100;
  const mapRow = options.mapRow ?? mapPostgresOutboxRow;

  return {
    async poll(cache) {
      const result = await options.client.query<CacheOutboxRow>(
        `select id, event_type, payload, created_at, processed_at, retry_count, last_error
from ${table}
where processed_at is null
order by created_at asc
limit $1`,
        [batchSize],
      );

      let processed = 0;
      let failed = 0;

      for (const row of result.rows) {
        try {
          await applyOutboxInvalidation(cache, mapRow(row));
          await markProcessed(options.client, table, row.id);
          processed += 1;
        } catch (error) {
          await markFailed(options.client, table, row.id, errorMessage(error));
          failed += 1;
        }
      }

      return {
        rows: result.rows.length,
        processed,
        failed,
      };
    },

    plugin() {
      let timer: ReturnType<typeof setInterval> | undefined;

      return {
        name: "safecache-postgres-outbox",

        setup(ctx: CachePluginContext) {
          if (options.pollOnStart) {
            void thisPoll(ctx);
          }
          if (options.pollIntervalMs) {
            timer = setInterval(() => {
              void thisPoll(ctx);
            }, options.pollIntervalMs);
          }
        },

        async shutdown() {
          if (timer) {
            clearInterval(timer);
            timer = undefined;
          }
        },
      };

      async function thisPoll(ctx: CachePluginContext): Promise<void> {
        try {
          await createPostgresOutbox(options).poll(ctx.cache);
        } catch (error) {
          ctx.emit({
            type: "error",
            operation: "postgres-outbox",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    },
  };
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

async function markProcessed(
  client: PostgresClientLike,
  table: string,
  id: string | number,
): Promise<void> {
  await client.query(
    `update ${table}
set processed_at = now(), last_error = null
where id = $1`,
    [id],
  );
}

async function markFailed(
  client: PostgresClientLike,
  table: string,
  id: string | number,
  error: string,
): Promise<void> {
  await client.query(
    `update ${table}
set retry_count = retry_count + 1, last_error = $2
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
