# Prisma Usage

The Prisma package provides mutation invalidation helpers. It does not automatically cache Prisma
queries.

## Install

```bash
pnpm add @safecache/prisma @safecache/core
```

## Wrap mutations explicitly

```ts
import { createPrismaCacheSync } from "@safecache/prisma";

const prismaCache = createPrismaCacheSync(cache);

await prismaCache.mutate({
  model: "User",
  id,
  action: () => prisma.user.update({ where: { id }, data }),
});
```

This invalidates `User` and `User:<id>` after the update succeeds.

## Prisma extension

```ts
const prisma = new PrismaClient().$extends(prismaCache.extension());
```

The extension invalidates after successful `create`, `update`, `upsert`, `delete`, `updateMany`,
and `deleteMany` operations.

## Tag behavior

Default tags are:

```txt
<Model>
<Model>:<id>
```

Customize them with `modelTag` and `entityTag` when your application uses a different naming
scheme.

## Common mistakes

- Expecting Prisma reads to be cached automatically.
- Invalidating only entity tags when list queries also exist.
- Ignoring `updateMany` and `deleteMany`, where an individual ID may not be known.

## Related docs

- [Tags and invalidation](tags-and-invalidation.md)
- [Cache-aside strategy](cache-aside-strategy.md)
