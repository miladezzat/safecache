# @safecache/express

Express middleware that attaches a SafeCache instance to each request.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/express @safecache/core
```

## Usage

```ts
import { safeCacheMiddleware } from "@safecache/express";

app.use(safeCacheMiddleware(cache));

app.get("/users/:id", async (req, res) => {
  const user = await req.safeCache.query({
    key: "user:" + req.params.id,
    tags: ["users"],
    fetcher: () => userRepo.findById(req.params.id),
  });
  res.json(user);
});
```

## API

- `safeCacheMiddleware`
- `SafeCacheRequest`

## When To Use This

Use this package when Express handlers should access a request-scoped cache reference without importing a global singleton.

## Production Notes

Attach one application-level cache instance. Protect any route that exposes operational cache controls.

## Related Packages

- `@safecache/core`
- `@safecache/fastify`
- `@safecache/nestjs`

## Documentation

- [Getting Started](../../docs/getting-started.md)
- [SafeCache README](../../README.md)
