# @safecache/mongoose

Mongoose mutation invalidation helpers for SafeCache. This package does not automatically cache
queries.

```ts
import { createMongooseCacheSync, registerMongooseHooks } from "@safecache/mongoose";

const sync = createMongooseCacheSync(cache);
registerMongooseHooks(userSchema, sync, { modelName: "User" });
```
