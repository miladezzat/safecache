# @safecache/serializers

Serializer adapters for SafeCache entries.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/serializers @safecache/core
```

## Usage

```ts
import { createCache } from "@safecache/core";
import { superJsonSerializer } from "@safecache/serializers";

const cache = createCache({
  namespace: "app",
  provider,
  serializer: superJsonSerializer(),
  defaultTtl: "5m",
});
```

## API

- `jsonSerializer`
- `superJsonSerializer`
- `msgpackSerializer`

## When To Use This

Use this package when the default JSON serializer is not enough for your cached values or provider payload format.

## Production Notes

Changing serializers can make old provider payloads unreadable. Roll serializer changes with a namespace change or cache flush plan.

## Related Packages

- `@safecache/core`

## Documentation

- [Core Concepts](../../docs/core-concepts.md)
- [SafeCache README](../../README.md)
