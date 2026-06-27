# @safecache/prisma

Prisma mutation invalidation helpers and extension factory.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/prisma @safecache/core
```

## Usage

```ts
import { createPrismaCacheSync } from "@safecache/prisma";

const sync = createPrismaCacheSync(cache);

await sync.mutate({
  model: "User",
  id,
  action: () => prisma.user.update({ where: { id }, data }),
});
```

## API

- `createPrismaCacheSync`
- `prismaModelTags`
- `prismaCachePlugin`

## When To Use This

Use this package to invalidate model and entity tags after Prisma create, update, upsert, and delete operations.

## Related Packages

- `@safecache/core`
- `@safecache/mongoose`

## Documentation

- [Prisma Usage](../../docs/prisma-usage.md)
- [Tags And Invalidation](../../docs/tags-and-invalidation.md)
- [SafeCache README](../../README.md)
