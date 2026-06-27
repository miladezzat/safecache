# @safecache/testing

Testing utilities for deterministic SafeCache setups.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/testing @safecache/core @safecache/memory
```

## Usage

```ts
import { createTestCache } from "@safecache/testing";

const { cache, clock } = createTestCache({ defaultTtl: "1m" });

await cache.query({ key: "answer", fetcher: async () => 42 });
clock.advance(60_001);
```

## API

- `createTestCache`
- `FakeClock`
- `FakeProvider`
- `MockEventBus`

## When To Use This

Use this package to test cache behavior without a real Redis, MongoDB, or Postgres dependency.

## Related Packages

- `@safecache/core`
- `@safecache/memory`

## Documentation

- [Getting Started](../../docs/getting-started.md)
- [Safety Model](../../docs/safety-model.md)
- [SafeCache README](../../README.md)
