# @safecache/decorators

Method decorators for explicit cache reads and mutation invalidation.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/decorators @safecache/core
```

## Usage

```ts
import { Cached, CacheSync, withSafeCache } from "@safecache/decorators";

class UsersService {
  @Cached({ key: (id: string) => "user:" + id, tags: (id) => ["user:" + id, "users"], ttl: "5m" })
  async findById(id: string) {
    return userRepo.findById(id);
  }

  @CacheSync({ tags: (id: string) => ["user:" + id, "users"] })
  async update(id: string, data: unknown) {
    return userRepo.update(id, data);
  }
}

const service = withSafeCache(new UsersService(), cache);
```

## API

- `Cached`
- `CacheSync`
- `withSafeCache`
- `getSafeCache`

## When To Use This

Use this package when a class-based service wants decorators without a hidden global cache singleton.

## Related Packages

- `@safecache/core`
- `@safecache/nestjs`

## Documentation

- [Decorators](../../docs/decorators.md)
- [Nestjs Usage](../../docs/nestjs-usage.md)
- [SafeCache README](../../README.md)
