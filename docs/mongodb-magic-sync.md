# MongoDB Magic Sync

MongoDB magic sync uses change streams to invalidate cache entries from database changes.

MongoDB change streams require a replica set or sharded cluster. SafeCache does not hide that
requirement.

```ts
import { mongoChangeStreams } from "@safecache/mongodb-streams";

cache.use(
  mongoChangeStreams({
    db,
    resumeToken,
    onResumeToken: (token) => saveResumeToken(token),
    collections: {
      users: {
        id: (doc) => doc._id,
        tags: (doc) => [`user:${doc._id}`, "users"],
      },
    },
  }),
);
```

Supported operations are `insert`, `update`, `replace`, and `delete`. Deletes use `documentKey` so
tag mappers should be able to work from an `_id` value.
