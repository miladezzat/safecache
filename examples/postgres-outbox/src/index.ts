import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";
import { cacheOutboxTableSql, createPostgresOutbox } from "@safecache/postgres-outbox";

const cache = createCache({
  namespace: "postgres-outbox-example",
  layers: [memoryProvider({ ttl: "5m" })],
  defaultTtl: "5m",
});

const outbox = createPostgresOutbox({
  client: {
    async query<TRow>() {
      return {
        rows: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            event_type: "cache.invalidate",
            payload: { tags: ["users"], keys: ["user:1"] },
            created_at: new Date(),
            processed_at: null,
            retry_count: 0,
            last_error: null,
          },
        ] as TRow[],
      };
    },
  },
});

export const createTableSql = cacheOutboxTableSql();

export async function pollOutbox() {
  return outbox.poll(cache);
}

export { cache };
