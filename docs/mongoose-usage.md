# Mongoose Usage

The Mongoose package registers post-mutation hooks for invalidation. It does not automatically cache
queries.

```ts
import { createMongooseCacheSync, registerMongooseHooks } from "@safecache/mongoose";

const sync = createMongooseCacheSync(cache);
registerMongooseHooks(userSchema, sync, { modelName: "User" });
```

SafeCache supports `save`, `insertMany`, `updateOne`, `findOneAndUpdate`, `deleteOne`, and
`deleteMany`. Tags are `<ModelName>` and `<ModelName>:<id>` when an ID is available.
