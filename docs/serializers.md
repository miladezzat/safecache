# Serializers

`@safecache/serializers` provides drop-in `CacheSerializer` implementations. A serializer controls
how a `CacheEntry` (value plus metadata) is turned into the `string | Uint8Array` a provider stores,
and back again. Pass one to `createCache` via the `serializer` option; the core default is JSON.

## Install

```bash
pnpm add @safecache/serializers @safecache/core
```

## Available serializers

```ts
import { jsonSerializer, superJsonSerializer, msgpackSerializer } from "@safecache/serializers";
```

- `jsonSerializer()` — re-exports the core JSON serializer. Standard JSON semantics; the simplest
  choice for plain data.
- `superJsonSerializer()` — JSON that round-trips `Date` values (and escapes its own markers) so
  date fields come back as `Date` instances instead of strings.
- `msgpackSerializer()` — encodes to bytes (`Uint8Array`), suitable for providers that store binary
  payloads.

## Usage

```ts
import { createCache } from "@safecache/core";
import { superJsonSerializer } from "@safecache/serializers";

const cache = createCache({
  namespace: "app",
  provider,
  defaultTtl: "5m",
  serializer: superJsonSerializer(),
});
```

## Choosing a serializer

- Use `jsonSerializer()` for plain JSON-safe data.
- Use `superJsonSerializer()` when cached values contain `Date` fields you need preserved.
- Use `msgpackSerializer()` when you want a compact binary representation and your provider stores
  bytes.

## Common mistakes

- Switching serializers without invalidating existing entries — old entries were written with the
  previous format.
- Expecting `jsonSerializer()` to revive `Date` objects; use `superJsonSerializer()` for that.
- Mixing serializers across instances that share the same provider keys.

## Related docs

- [Core concepts](core-concepts.md)
- [Safety model](safety-model.md)
