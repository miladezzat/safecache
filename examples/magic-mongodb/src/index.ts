import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";
import { mongoChangeStreams } from "@safecache/mongodb-streams";

const cache = createCache({
  namespace: "mongodb-example",
  layers: [memoryProvider({ ttl: "5m" })],
  defaultTtl: "5m",
});

cache.use(
  mongoChangeStreams({
    db: {
      collection() {
        return {
          watch() {
            return {
              on() {},
              close() {},
            };
          },
        };
      },
    },
    collections: {
      users: {
        id: (doc: { _id: string }) => doc._id,
        tags: (doc: { _id: string }) => [`user:${doc._id}`, "users"],
      },
    },
  }),
);

export { cache };
