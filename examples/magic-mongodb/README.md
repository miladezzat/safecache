# MongoDB Magic Sync Example

This example demonstrates the MongoDB change stream plugin shape for optional automatic
invalidation.

## What it demonstrates

- `mongoChangeStreams()`
- collection-to-tag mapping
- resume token hook shape
- plugin registration through `cache.use()`

## Packages used

```txt
@safecache/core
@safecache/memory
@safecache/mongodb-streams
```

## Verify the example

```bash
pnpm --filter magic-mongodb typecheck
pnpm --filter magic-mongodb build
```

## Walkthrough

```ts
cache.use(
  mongoChangeStreams({
    db,
    collections: {
      users: {
        id: (doc) => doc._id,
        tags: (doc) => [`user:${doc._id}`, "users"],
      },
    },
  }),
);
```

The example uses a fake database object so it can typecheck without requiring a live MongoDB
server.

## Production requirements

MongoDB change streams require a replica set or sharded cluster. Persist resume tokens if this
plugin is used for production invalidation.

## Expected behavior

When a configured collection emits a change, SafeCache maps the changed document to keys and tags
and invalidates them.

## Related docs

- [MongoDB magic sync](../../docs/mongodb-magic-sync.md)
- [Tags and invalidation](../../docs/tags-and-invalidation.md)
