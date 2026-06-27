# Namespaces And Tenants

Namespaces and tenants prevent key collisions across applications, environments, and SaaS tenants.

## Namespace

Every cache requires a namespace:

```ts
const cache = createCache({
  namespace: "billing-api",
  provider,
  defaultTtl: "5m",
});
```

The namespace is part of the scoped cache key. Use stable names such as service names, not deploy
IDs.

## Tenant

Pass `tenant` on operations when cached data is tenant-specific:

```ts
await cache.query({
  tenant: tenantId,
  key: `invoice:${invoiceId}`,
  tags: [`invoice:${invoiceId}`, "invoices"],
  fetcher: () => invoiceRepo.findById(tenantId, invoiceId),
});
```

Use the same tenant when invalidating:

```ts
await cache.invalidateByTag("invoices", { tenant: tenantId });
```

## Key format

SafeCache scopes keys as:

```txt
namespace::<key>
namespace::tenant:<tenant>::<key>
```

Tag indexes use the same scope so tag invalidation stays isolated.

## Common mistakes

- Reusing one namespace for unrelated apps.
- Including tenant IDs manually in both `key` and `tenant`.
- Invalidating a tenant-scoped key without passing `tenant`.
- Using environment-specific namespace names when data should survive deploys.

## Related docs

- [Tags and invalidation](tags-and-invalidation.md)
- [Distributed invalidation](distributed-invalidation.md)
