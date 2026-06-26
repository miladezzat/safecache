import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";
import { createPostgresOutbox } from "@safecache/postgres-outbox";

const cache = createCache({
  namespace: "postgres-outbox-example",
  layers: [memoryProvider({ ttl: "5m" })],
  defaultTtl: "5m",
});

const outbox = createPostgresOutbox({
  client: {
    async query() {
      return { rows: [] };
    },
  },
});

export async function pollOutbox(): Promise<void> {
  await outbox.poll(cache);
}

export { cache };
