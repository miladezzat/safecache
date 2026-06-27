# Valkey Provider

`@safecache/valkey` is a thin wrapper over `@safecache/redis` for [Valkey](https://valkey.io/), the
open-source fork of Redis. Because Valkey is wire-compatible with Redis, the provider reuses the
Redis implementation and only changes the default tag-index prefix so Valkey and Redis deployments
do not collide on shared infrastructure.

## Install

```bash
pnpm add @safecache/valkey @safecache/redis @safecache/core
```

Add your Valkey/Redis-compatible client separately.

## Provider setup

```ts
import { createCache } from "@safecache/core";
import { valkeyProvider } from "@safecache/valkey";

const cache = createCache({
  namespace: "app",
  provider: valkeyProvider(valkey),
  defaultTtl: "5m",
});
```

## Options

`valkeyProvider(client, options)` accepts the same options as `redisProvider` (the types
`ValkeyProviderClient`, `ValkeyProviderOptions`, and `ValkeyProvider` alias the Redis equivalents).
The only behavioral difference is the default `tagPrefix`, which is namespaced to Valkey
(`__safecache:valkey:tags`). Override it if you need a custom prefix:

```ts
valkeyProvider(valkey, { tagPrefix: "myapp:valkey:tags" });
```

## Client shape and coordination

The required client methods and the distributed lock / Pub-Sub setup are identical to Redis. See
[Redis setup](redis-setup.md) for the expected client shape, multi-layer configuration, and
distributed coordination — everything there applies to Valkey.

## Common mistakes

- Pointing Valkey and Redis providers at the same instance with the same tag prefix.
- Assuming Valkey-specific commands; the provider only uses the common Redis subset.

## Related docs

- [Redis setup](redis-setup.md)
- [Distributed invalidation](distributed-invalidation.md)
- [Safety model](safety-model.md)
