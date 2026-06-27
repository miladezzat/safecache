# @safecache/valkey

Valkey-compatible provider wrapper built on the Redis provider contract.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/valkey @safecache/core
```

## Usage

```ts
import { valkeyProvider } from "@safecache/valkey";

const cache = createCache({
  namespace: "app",
  provider: valkeyProvider(valkeyClient),
  defaultTtl: "5m",
});
```

## API

- `valkeyProvider`
- `ValkeyProvider`
- `ValkeyProviderClient`

## When To Use This

Use this package when your Redis-compatible backing store is Valkey and you want Valkey-specific package naming.

## Related Packages

- `@safecache/core`
- `@safecache/redis`
- `@safecache/locks`
- `@safecache/pubsub`

## Documentation

- [Redis Setup](../../docs/redis-setup.md)
- [SafeCache README](../../README.md)
