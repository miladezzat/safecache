# @safecache/prisma

Prisma mutation invalidation helpers for SafeCache. This package does not automatically cache
queries.

```ts
import { createPrismaCacheSync } from "@safecache/prisma";

const prismaCache = createPrismaCacheSync(cache);
const prisma = new PrismaClient().$extends(prismaCache.extension());
```
