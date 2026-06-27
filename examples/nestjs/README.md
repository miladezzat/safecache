# NestJS Example

This example demonstrates the lightweight NestJS integration for SafeCache with a real Redis
connection factory. It is intentionally not a full Nest application; it shows the module, Redis
connection, and service shapes that should be copied into an app.

## What it demonstrates

- `SafeCacheModule.forRoot()`
- `SafeCacheModule.forRootAsync()`
- `SafeCacheService`
- Redis connection setup with `node-redis`
- memory + Redis cache layers
- Redis locks and Pub/Sub
- explicit cache dependency injection
- no hidden global singleton

## Packages used

```txt
@safecache/core
@safecache/locks
@safecache/memory
@safecache/nestjs
@safecache/pubsub
@safecache/redis
redis
```

## Verify the example

```bash
pnpm --filter nestjs typecheck
pnpm --filter nestjs build
```

## Walkthrough

The example creates a Redis connection with `node-redis`:

```ts
export async function createRedisConnection(url: string): Promise<RedisClientType> {
  const client = createClient({ url });
  await client.connect();
  return client;
}
```

It adapts that client to the SafeCache Redis provider, lock, and Pub/Sub interfaces:

```ts
const redis = adaptRedisClient(await createRedisConnection(options.url));
```

Then it registers SafeCache through async NestJS module setup. `onError` is the
fail-safe notifier: SafeCache is fail-open, so cache-side faults never reach the
request — they are routed here so a degraded cache stays observable:

```ts
export const moduleDefinition = SafeCacheModule.forRootAsync({
  useFactory: () =>
    createRedisBackedCache({
      url: process.env.REDIS_URL ?? "redis://localhost:6379",
      namespace: process.env.SAFECACHE_NAMESPACE ?? "nestjs-api",
      source: process.env.HOSTNAME ?? "nestjs-api",
    }),
  onError: (error) => {
    console.error("[safecache] cache degraded:", error.message);
  },
});
```

When the cache is built synchronously (no async Redis connection to await),
register it with `forRoot()` instead:

```ts
export const memoryModuleDefinition = SafeCacheModule.forRoot({
  cache: createCache({
    namespace: "nestjs-memory",
    layers: [memoryProvider({ ttl: "30s" })],
    defaultTtl: "5m",
    safety: { failOpen: true, preventStampede: true },
  }),
  onError: (error) => {
    console.error("[safecache] cache degraded:", error.message);
  },
});
```

A service can receive `SafeCacheService` through NestJS dependency injection:

```ts
export class UsersService {
  constructor(private readonly safeCache: SafeCacheService) {}

  findById(id: string) {
    return this.safeCache.query({
      key: `user:${id}`,
      tags: [`user:${id}`, "users"],
      fetcher: async () => ({ id, name: "Ada" }),
    });
  }
}
```

## What to copy into a real app

- Create the cache in your module composition layer.
- Import `SafeCacheModule.forRootAsync()` when the Redis connection is async, or
  `SafeCacheModule.forRoot()` when the cache is built synchronously.
- Pass `onError` so a degraded cache reaches your logger / Sentry / metrics.
- Inject `SafeCacheService` into application services.
- Keep invalidation close to write methods.
- Use separate Redis clients for Pub/Sub in applications that need dedicated subscriber
  connections.

## Related docs

- [NestJS usage](../../docs/nestjs-usage.md)
- [Decorators](../../docs/decorators.md)
