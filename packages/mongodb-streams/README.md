# @safecache/mongodb-streams

MongoDB change stream plugin for cache invalidation from database changes.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/mongodb-streams @safecache/core
```

## Usage

```ts
import { mongoChangeStreams } from "@safecache/mongodb-streams";

cache.use(
  mongoChangeStreams({
    db,
    collections: {
      users: {
        tags: (doc) => ["user:" + doc._id, "users"],
      },
    },
  }),
);
```

## API

- `mongoChangeStreams`
- `mapMongoChangeToInvalidation`
- `requiresMongoReplicaSet`

## When To Use This

Use this package when MongoDB writes outside the current process should invalidate SafeCache keys or tags.

## Related Packages

- `@safecache/core`
- `@safecache/mongoose`
- `@safecache/postgres-outbox`

## Documentation

- [Mongodb Magic Sync](../../docs/mongodb-magic-sync.md)
- [Mongoose Usage](../../docs/mongoose-usage.md)
- [SafeCache README](../../README.md)
