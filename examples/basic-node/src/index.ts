import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";

type User = { id: string; name: string };

const users = new Map<string, User>([["1", { id: "1", name: "Ada" }]]);
let fetchCount = 0;
let errorCount = 0;

export const cache = createCache({
  namespace: "basic-node",
  provider: memoryProvider(),
  defaultTtl: "5m",
  safety: {
    failOpen: true,
    preventStampede: true,
  },
  // Fail-safe notifier. SafeCache is fail-open: internal faults (provider
  // get/set, (de)serialization, tag-index ops, ...) are NEVER thrown into your
  // application, but they ARE reported here so a degraded cache stays
  // observable. Wire this to your logger / Sentry / metrics. The notifier is
  // invoked defensively — if it throws, the throw is swallowed.
  onError: (event) => {
    console.error(`[safecache] ${event.operation} failed:`, event.error.message);
  },
});

// The same stream is also available imperatively via `cache.on("error", ...)`,
// which is handy when you want to attach a handler after construction.
cache.on("error", (event) => {
  if (event.type === "error") {
    errorCount += 1;
  }
});

export async function getUser(id: string) {
  return cache.query({
    key: `user:${id}`,
    tags: [`user:${id}`, "users"],
    fetcher: async () => {
      fetchCount += 1;
      return users.get(id) ?? null;
    },
  });
}

export async function updateUser(id: string, data: Partial<User>) {
  return cache.mutate({
    tags: [`user:${id}`, "users"],
    action: async () => {
      const current = users.get(id);
      if (!current) {
        throw new Error(`User ${id} not found`);
      }
      const next = { ...current, ...data };
      users.set(id, next);
      return next;
    },
  });
}

export async function runBasicNodeExample() {
  fetchCount = 0;
  errorCount = 0;

  const firstRead = await getUser("1");
  const secondRead = await getUser("1");
  const updated = await updateUser("1", { name: "Ada Lovelace" });
  const afterMutation = await getUser("1");

  return {
    firstRead,
    secondRead,
    updated,
    afterMutation,
    fetchCount,
    // 0 in the happy path; a non-zero value here means the cache degraded.
    errorCount,
    stats: cache.stats(),
  };
}
