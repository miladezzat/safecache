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

## Primary Key Inference

By default the entity tag is derived from a **literal `id` field** read from
`args.where`, `args.data`, or the operation result. This shallow assumption does
NOT cover:

- a non-`id` primary key (e.g. `uuid`),
- a compound / multi-column key, or
- the row set behind `updateMany` / `deleteMany` (which can match many rows).

For these cases, either configure id resolution or pass explicit tags:

```ts
// Custom primary key:
createPrismaCacheSync(cache, { idField: "uuid" });

// Compound key (flat or Prisma's `a_b` wrapper, e.g. `{ tenantId_userId: {...} }`):
createPrismaCacheSync(cache, { idField: ["tenantId", "userId"] });

// Full control (return one id, several ids, or undefined):
createPrismaCacheSync(cache, { idExtractor: (args, result) => /* ... */ });

// Or map the mutation explicitly:
await sync.mutate({ model: "Membership", tags: ["Membership:t1:u1"], action });
```

When a mutation cannot be reduced to a precise entity tag, only the model tag is
invalidated and an `onUnmappableMutation` signal fires (`reason: "no-id"` or
`"scope"`) so the imprecision is observable rather than silently skipped.

## Safety: Cache Errors Never Break Your Write

A cache-side invalidation failure is **never** thrown into your Prisma operation
by default. A committed write stays committed even if the cache is down; the error
is routed to the `onInvalidationError(error, tag)` notifier (a silent no-op by
default — wire it to your logger / Sentry). Notifier callbacks are invoked
defensively, so a throwing notifier can never break the host either. Only two
things propagate: your own `action` / DB call throwing, and the explicit opt-in
`propagateInvalidationErrors: true`.

## Production Notes

This package invalidates mutations; it does not cache Prisma reads automatically. Cached reads still need explicit SafeCache `query()` calls.

## Related Packages

- `@safecache/core`
- `@safecache/mongoose`

## Documentation

- [Prisma Usage](../../docs/prisma-usage.md)
- [Tags And Invalidation](../../docs/tags-and-invalidation.md)
- [SafeCache README](../../README.md)
