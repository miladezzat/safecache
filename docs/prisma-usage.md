# Prisma Usage

The Prisma package provides mutation invalidation helpers. It does not automatically cache Prisma
queries.

```ts
import { createPrismaCacheSync } from "@safecache/prisma";

const prismaCache = createPrismaCacheSync(cache);
const prisma = new PrismaClient().$extends(prismaCache.extension());
```

SafeCache invalidates after successful `create`, `update`, `upsert`, `delete`, `updateMany`, and
`deleteMany` calls. Tags are `<Model>` and `<Model>:<id>` when an ID is available.
