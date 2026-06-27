# Tags And Invalidation

Tags let one mutation invalidate every cached value that depends on the same entity or collection.

## Tag shape

Use both entity-level and collection-level tags:

```ts
await cache.query({
  key: `user:${id}`,
  tags: [`user:${id}`, "users"],
  fetcher: () => userRepo.findById(id),
});
```

The entity tag invalidates one user. The collection tag invalidates lists or aggregates that include
users.

## Invalidate after mutation

Prefer `mutate()` for write paths:

```ts
await cache.mutate({
  tags: [`user:${id}`, "users"],
  action: () => userRepo.update(id, data),
});
```

SafeCache runs the action first. If it succeeds, the matching tags are invalidated.

## Direct invalidation

Use direct invalidation for operational tools, background jobs, or plugin integrations:

```ts
await cache.invalidate(`user:${id}`);
await cache.invalidateByTag("users");
```

## Tenant-aware invalidation

When a query uses a tenant, invalidation should use the same tenant.

```ts
await cache.invalidateByTag("users", { tenant: tenantId });
```

## Common mistakes

- Only tagging individual entities and forgetting list tags.
- Using inconsistent tag names across read and write paths.
- Invalidating before a write commits.
- Sharing tags across tenants without tenant scoping.

## Related packages

- `@safecache/core`
- `@safecache/prisma`
- `@safecache/mongoose`
- `@safecache/mongodb-streams`
- `@safecache/postgres-outbox`
