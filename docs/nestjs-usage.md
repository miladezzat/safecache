# NestJS Usage

The NestJS adapter provides module and service integration without adding NestJS to
`@safecache/core`.

## Install

```bash
pnpm add @safecache/core @safecache/memory @safecache/nestjs
```

## Register the module

```ts
import { Module } from "@nestjs/common";
import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";
import { SafeCacheModule } from "@safecache/nestjs";

const cache = createCache({
  namespace: "api",
  provider: memoryProvider(),
  defaultTtl: "5m",
});

@Module({
  imports: [SafeCacheModule.forRoot({ cache })],
})
export class AppModule {}
```

## Inject the service

```ts
import { Injectable } from "@nestjs/common";
import { SafeCacheService } from "@safecache/nestjs";

@Injectable()
export class UsersService {
  constructor(private readonly safeCache: SafeCacheService) {}

  findById(id: string) {
    return this.safeCache.query({
      key: `user:${id}`,
      tags: [`user:${id}`, "users"],
      fetcher: () => this.loadUser(id),
    });
  }

  private async loadUser(id: string) {
    return userRepo.findById(id);
  }
}
```

## Redis-backed async setup

Use `forRootAsync()` when Redis clients or configuration are created asynchronously.

```ts
SafeCacheModule.forRootAsync({
  useFactory: async () =>
    createCache({
      namespace: "api",
      layers: [memoryProvider({ ttl: "30s" }), redisProvider(redis)],
      distributed: {
        lock: redisLock(redis),
        events: redisPubSub(redis),
      },
      defaultTtl: "5m",
    }),
});
```

## Common mistakes

- Creating a cache per request instead of one application-level instance.
- Importing a global cache directly inside services instead of injecting `SafeCacheService`.
- Forgetting to invalidate after mutations.

## Related example

- [NestJS Example](../examples/nestjs/README.md)
