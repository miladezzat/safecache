# @safecache/express

Express middleware that attaches a SafeCache instance to each request.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/express @safecache/core
```

## Usage

Importing this package augments Express's own `Request` type, so `req.safeCache`
is typed on every handler with no casting required:

```ts
import { safeCacheMiddleware } from "@safecache/express";

app.use(safeCacheMiddleware(cache));

app.get("/users/:id", async (req, res) => {
  // `req.safeCache` is optional: the middleware is fail-open and may leave it
  // unset if attaching the cache ever fails. Treat a missing cache as "no cache"
  // and read through to your source of truth.
  const fetchUser = () => userRepo.findById(req.params.id);
  const user = req.safeCache
    ? await req.safeCache.query({
        key: "user:" + req.params.id,
        tags: ["users"],
        fetcher: fetchUser,
      })
    : await fetchUser();
  res.json(user);
});
```

### Observing cache-side failures

SafeCache never throws cache-side failures into your app. The middleware will
not break the Express pipeline even if attaching the cache fails — it simply
calls `next()` and leaves `req.safeCache` unset. Pass `onError` to observe these
failures (wire it to your logger / Sentry). It defaults to a silent no-op.

```ts
app.use(
  safeCacheMiddleware(cache, {
    onError: (error) => logger.warn({ err: error }, "safecache attach failed"),
  }),
);
```

## API

- `safeCacheMiddleware(cache, options?)`
- `SafeCacheMiddlewareOptions` (`{ onError?: (error: Error) => void }`)
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
