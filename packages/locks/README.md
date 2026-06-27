# @safecache/locks

Redis distributed lock adapter for SafeCache stampede prevention.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/locks @safecache/core
```

## Usage

```ts
import { redisLock } from "@safecache/locks";

const cache = createCache({
  namespace: "app",
  provider,
  distributed: {
    lock: redisLock(redis),
  },
  defaultTtl: "5m",
});
```

## API

- `redisLock`
- `RedisLockClient`
- `RedisLockOptions`

## When To Use This

Use this package with Redis when multiple app instances need one owner for a cache refresh.

## Production Notes

Choose a lock TTL longer than the expected fetcher runtime. Prefer clients that support `eval` so lock release is token-safe.

## Related Packages

- `@safecache/core`
- `@safecache/redis`
- `@safecache/pubsub`

## Documentation

- [Stampede Prevention](../../docs/stampede-prevention.md)
- [Redis Setup](../../docs/redis-setup.md)
- [SafeCache README](../../README.md)
