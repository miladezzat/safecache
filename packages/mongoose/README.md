# @safecache/mongoose

Mongoose cache invalidation helpers and schema hooks.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/mongoose @safecache/core
```

## Usage

```ts
import { createMongooseCacheSync, registerMongooseHooks } from "@safecache/mongoose";

const sync = createMongooseCacheSync(cache);
registerMongooseHooks(UserSchema, sync, { modelName: "User" });
```

## API

- `createMongooseCacheSync`
- `registerMongooseHooks`
- `mongooseModelTags`
- `mongooseCachePlugin`

## When To Use This

Use this package to invalidate model and document tags after Mongoose mutation hooks.

## Related Packages

- `@safecache/core`
- `@safecache/mongodb-streams`

## Documentation

- [Mongoose Usage](../../docs/mongoose-usage.md)
- [Tags And Invalidation](../../docs/tags-and-invalidation.md)
- [SafeCache README](../../README.md)
