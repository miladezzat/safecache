# Mongoose Usage

The Mongoose package registers post-mutation hooks for invalidation. It does not automatically
cache Mongoose queries.

## Install

```bash
pnpm add @safecache/mongoose @safecache/core
```

## Register hooks

```ts
import { createMongooseCacheSync, registerMongooseHooks } from "@safecache/mongoose";

const sync = createMongooseCacheSync(cache);
registerMongooseHooks(userSchema, sync, { modelName: "User" });
```

Supported hooks:

```txt
save
insertMany
updateOne
findOneAndUpdate
deleteOne
deleteMany
```

## Tag behavior

Default tags are:

```txt
<ModelName>
<ModelName>:<id>
```

When an ID is unavailable, SafeCache invalidates the model-level tag so list and aggregate queries
can be refreshed.

## Common mistakes

- Expecting query caching from the Mongoose plugin.
- Registering hooks after models are already compiled.
- Not tagging cached reads with the same model/document tags.
- Assuming bulk operations always include individual document IDs.

## Related docs

- [MongoDB magic sync](mongodb-magic-sync.md)
- [Tags and invalidation](tags-and-invalidation.md)
