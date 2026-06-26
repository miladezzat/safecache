import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";

type User = { id: string; name: string };

const users = new Map<string, User>([["1", { id: "1", name: "Ada" }]]);

export const cache = createCache({
  namespace: "basic-node",
  provider: memoryProvider(),
  defaultTtl: "5m",
  safety: {
    failOpen: true,
    preventStampede: true,
  },
});

export async function getUser(id: string) {
  return cache.query({
    key: `user:${id}`,
    tags: [`user:${id}`, "users"],
    fetcher: async () => users.get(id) ?? null,
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
