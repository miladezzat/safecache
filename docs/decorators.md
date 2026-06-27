# Decorators

Decorators are optional ergonomic wrappers for method-level caching and cache synchronization. They
delegate to the same core APIs as manual code.

## Install

```bash
pnpm add @safecache/core @safecache/decorators
```

## Attach a cache explicitly

SafeCache does not use a hidden global singleton. Attach a cache to the service instance:

```ts
import { Cached, CacheSync, withSafeCache } from "@safecache/decorators";

class UsersService {
  @Cached({
    key: (id: string) => `user:${id}`,
    tags: (id: string) => [`user:${id}`, "users"],
    ttl: "5m",
  })
  async findById(id: string) {
    return userRepo.findById(id);
  }

  @CacheSync({
    tags: (id: string) => [`user:${id}`, "users"],
  })
  async update(id: string, data: unknown) {
    return userRepo.update(id, data);
  }
}

export const usersService = withSafeCache(new UsersService(), cache);
```

## When to use decorators

Use decorators when service methods map cleanly to cache keys and tags. Prefer direct `cache.query()`
calls when the read path has complex branching or needs more explicit control.

## Common mistakes

- Forgetting `withSafeCache(instance, cache)`.
- Using decorators to hide important invalidation choices.
- Adding decorators before deciding tag names.
- Assuming decorators are required; they are optional.

## Related docs

- [Getting started](getting-started.md)
- [NestJS usage](nestjs-usage.md)
- [Tags and invalidation](tags-and-invalidation.md)
