# Core Concepts

SafeCache has a small set of core building blocks: cache-aside reads, providers, entries, tags,
namespaces, tenants, safety controls, and optional distributed coordination.

## Cache-aside reads

The core API is `cache.query()`.

```ts
const value = await cache.query({
  key: "settings:public",
  tags: ["settings"],
  ttl: "10m",
  fetcher: () => settingsRepo.loadPublicSettings(),
});
```

SafeCache checks providers first. If no valid value exists, it calls `fetcher()`, serializes the
entry, and writes it to configured layers.

## Providers and layers

A provider implements `get`, `set`, and `delete`. Providers can also expose a tag index and health
check.

```ts
createCache({
  namespace: "app",
  layers: [memoryProvider({ ttl: "30s" }), redisProvider(redis)],
  defaultTtl: "5m",
});
```

Layer order matters. Reads check the first layer first. Hits in slower layers backfill faster
layers.

## Entries

SafeCache stores a cache entry, not only a raw value. Entries include:

```txt
value
tags
createdAt
expiresAt
staleUntil
version
```

The serializer controls how entries are written to providers.

## Tags

Tags group related keys. A user detail key can use both a specific tag and a collection tag:

```ts
tags: [`user:${id}`, "users"];
```

That lets one mutation invalidate one user or a full collection.

## Namespaces and tenants

`namespace` is required and appears in scoped keys. `tenant` is optional per operation and isolates
SaaS tenant data.

```ts
await cache.query({
  tenant: tenantId,
  key: `user:${id}`,
  tags: [`user:${id}`],
  fetcher,
});
```

## Safety controls

SafeCache defaults toward application availability:

- fail open to fetchers when providers fail
- prevent same-process stampedes
- avoid caching `null` unless configured
- avoid caching errors unless configured
- emit runtime events for observability

## Plugins and distributed features

Plugins extend cache behavior without changing core. Distributed locks and event buses are optional
interfaces:

```ts
createCache({
  namespace: "app",
  provider,
  distributed: {
    lock,
    events,
  },
});
```

## Related packages

- `@safecache/core`
- `@safecache/memory`
- `@safecache/redis`
- `@safecache/locks`
- `@safecache/pubsub`
