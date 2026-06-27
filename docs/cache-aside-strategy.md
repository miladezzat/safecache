# Cache-Aside Strategy

SafeCache uses cache-aside as its primary strategy. Application code owns the source-of-truth read
through a `fetcher`, and SafeCache owns the repeatable cache mechanics around it.

## Read flow

```txt
request -> cache.query()
        -> check cache layers
        -> return valid hit
        -> otherwise call fetcher()
        -> store fresh entry
        -> return fresh value
```

```ts
const account = await cache.query({
  key: `account:${id}`,
  tags: [`account:${id}`, "accounts"],
  ttl: "2m",
  fetcher: () => accountRepo.findById(id),
});
```

## Why cache-aside

Cache-aside keeps database reads explicit. That matters because the application can decide:

- which query is safe to cache
- which tags describe the result
- which TTL is appropriate
- whether stale values are acceptable
- how to invalidate after writes

SafeCache does not automatically cache arbitrary ORM reads by default.

## Write flow

```txt
request -> cache.mutate()
        -> run action()
        -> invalidate keys/tags after success
        -> return action result
```

```ts
await cache.mutate({
  tags: [`account:${id}`, "accounts"],
  action: () => accountRepo.update(id, patch),
});
```

## Common mistakes

- Caching broad list queries without a collection tag.
- Using one TTL for all data classes.
- Mutating the database outside `mutate()` without another invalidation path.
- Caching errors instead of handling source failures explicitly.

## Related examples

- [Basic Node Example](../examples/basic-node/README.md)
- [Redis Distributed Example](../examples/redis-distributed/README.md)
