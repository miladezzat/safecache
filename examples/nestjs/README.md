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

Then it registers SafeCache through async NestJS module setup:

```ts
export const moduleDefinition = SafeCacheModule.forRootAsync({
  useFactory: () =>
    createRedisBackedCache({
      url: process.env.REDIS_URL ?? "redis://localhost:6379",
      namespace: process.env.SAFECACHE_NAMESPACE ?? "nestjs-example",
      source: process.env.HOSTNAME ?? "nestjs-api",
    }),
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
- Import `SafeCacheModule.forRootAsync()` when the Redis connection is async.
- Inject `SafeCacheService` into application services.
- Keep invalidation close to write methods.
- Use separate Redis clients for Pub/Sub in applications that need dedicated subscriber
  connections.

## Related docs

- [NestJS usage](../../docs/nestjs-usage.md)
- [Decorators](../../docs/decorators.md)
