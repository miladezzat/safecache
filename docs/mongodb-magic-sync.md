# MongoDB Magic Sync

MongoDB magic sync uses change streams to invalidate cache entries when database changes happen
outside the current request path.

## Requirements

MongoDB change streams require a replica set or sharded cluster. SafeCache does not hide that
requirement.

```bash
pnpm add @safecache/mongodb-streams @safecache/core
```

## Configure collections

```ts
import { mongoChangeStreams } from "@safecache/mongodb-streams";

cache.use(
  mongoChangeStreams({
    db,
    resumeToken,
    onResumeToken: (token) => saveResumeToken(token),
    collections: {
      users: {
        tags: (doc) => [`user:${doc._id}`, "users"],
        keys: (doc) => [`user:${doc._id}`],
      },
    },
  }),
);
```

Supported operations are `insert`, `update`, `replace`, and `delete`. Deletes use `documentKey`,
so mappers should be able to work from an `_id`-shaped document.

## When to use this

Use MongoDB streams when cache invalidation must react to writes from other services, scripts, or
workers. For request-local writes, prefer `cache.mutate()` because it is simpler and easier to
reason about.

## Common mistakes

- Running change streams against a standalone MongoDB server.
- Not persisting resume tokens.
- Emitting overly broad invalidations for every collection.
- Treating change streams as a replacement for write-path invalidation.

## Related example

- [MongoDB Magic Sync Example](../examples/magic-mongodb/README.md)
