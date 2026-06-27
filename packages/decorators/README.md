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
- `setSafeCacheDecoratorErrorHandler`

## Legacy Decorators Only

These decorators are implemented against the **legacy / experimental** decorator
signature (the third decorator argument is a `PropertyDescriptor`). They require:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
  },
}
```

Under **TC39 / standard** decorators (the default in TypeScript 5 without
`experimentalDecorators`) the third argument is a `ClassMethodDecoratorContext`
instead, so `@Cached` / `@CacheSync` cannot wrap the method and become a **no-op**.
When the mismatch is detectable at decoration time they emit a `console.warn`
rather than silently doing nothing.

## TTL Is Required (Unless `defaultTtl`)

`@Cached` needs a `ttl` **unless** the cache was created with a `defaultTtl`.
Core only validates this on the first call (`query() requires ttl unless
defaultTtl is configured`). Because the cache's `defaultTtl` is not visible at
decoration time, `@Cached` warns early when `ttl` is omitted. Even when
misconfigured the method stays fail-safe — the real value is still returned —
but caching is effectively disabled until `ttl` or `defaultTtl` is supplied.

## Fail-Safe Guarantees

This is a hot-path adapter, so both decorators are bulletproof:

- **`@Cached`** — if `cache.query` throws for any reason (core is fail-open, so
  this is rare), the decorated method still returns the real value by invoking
  the original method directly, and the cache error is routed to the notifier.
- **`@CacheSync`** — the original method runs first and its result is captured.
  Invalidations then run with `Promise.allSettled`, so one failing key/tag never
  stops the rest, and no invalidation error ever propagates: failures are routed
  to the notifier and the original result is returned regardless.

### Error Notifier

Supply `onError` per decorator, or install a process-wide handler:

```ts
import { setSafeCacheDecoratorErrorHandler } from "@safecache/decorators";

setSafeCacheDecoratorErrorHandler((error) =>
  logger.warn({ err: error }, "safecache decorator error"),
);
```

The per-decorator `onError` takes precedence over the module-level handler. The
notifier is invoked defensively — if it throws, the throw is swallowed so error
reporting can never break the decorated method.

## When To Use This

Use this package when a class-based service wants decorators without a hidden global cache singleton.

## Production Notes

Decorators are optional. Use them when method boundaries are clean, and keep cache injection explicit with `withSafeCache()`.

## Related Packages

- `@safecache/core`
- `@safecache/nestjs`

## Documentation

- [Decorators](../../docs/decorators.md)
- [Nestjs Usage](../../docs/nestjs-usage.md)
- [SafeCache README](../../README.md)
