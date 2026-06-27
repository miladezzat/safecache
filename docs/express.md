# Express Middleware

`@safecache/express` attaches a request-scoped SafeCache reference to every request as
`req.safeCache`, so route handlers can read and invalidate the cache without importing it directly.
It upholds the SafeCache guarantee in the request hot path: if attaching the cache ever fails, the
error is routed to `onError` and the request continues as if the cache were absent — it never throws
into the Express pipeline.

## Install

```bash
pnpm add @safecache/express @safecache/core
```

## Usage

```ts
import express from "express";
import { createCache } from "@safecache/core";
import { safeCacheMiddleware } from "@safecache/express";

const cache = createCache({ namespace: "app", provider, defaultTtl: "5m" });
const app = express();

app.use(
  safeCacheMiddleware(cache, {
    onError: (error) => logger.warn(error, "safecache middleware degraded"),
  }),
);

app.get("/users/:id", async (req, res) => {
  const user = await req.safeCache!.query({
    key: `user:${req.params.id}`,
    tags: [`user:${req.params.id}`],
    fetcher: () => userRepo.findById(req.params.id),
  });
  res.json(user);
});
```

Importing from this package also augments Express's own `Request` type, so `req.safeCache` is typed
without casting when `@types/express` is present.

## Options

- `onError?: (error: Error) => void` — notifier invoked if attaching the cache to a request fails.
  Defaults to a silent no-op. Such failures are reported here and swallowed; `next(error)` is never
  called with a cache-side error.

## Common mistakes

- Registering the middleware after the routes that depend on `req.safeCache`.
- Assuming `req.safeCache` is always set — guard for it (it is left unset if attaching failed).

## Related docs

- [Fastify plugin](fastify.md)
- [Core concepts](core-concepts.md)
- [Safety model](safety-model.md)
