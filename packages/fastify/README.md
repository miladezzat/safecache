# @safecache/fastify

Fastify plugin that decorates requests with a SafeCache instance.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/fastify @safecache/core
```

## Usage

```ts
import { safeCacheFastifyPlugin } from "@safecache/fastify";

await fastify.register(safeCacheFastifyPlugin(cache));

fastify.get("/users/:id", async (request) => {
  return request.safeCache.query({
    key: "user:" + request.params.id,
    tags: ["users"],
    fetcher: () => userRepo.findById(request.params.id),
  });
});
```

## API

- `safeCacheFastifyPlugin`
- `SafeCacheFastifyRequest`

## When To Use This

Use this package when Fastify routes should access SafeCache from the request object.

## Production Notes

Register the plugin once during app setup. Avoid creating a cache per request.

## Related Packages

- `@safecache/core`
- `@safecache/express`
- `@safecache/nestjs`

## Documentation

- [Getting Started](../../docs/getting-started.md)
- [SafeCache README](../../README.md)
