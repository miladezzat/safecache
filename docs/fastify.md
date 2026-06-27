# Fastify Plugin

`@safecache/fastify` registers a Fastify plugin that decorates every request with `request.safeCache`,
so handlers can reach the cache without importing it directly. The plugin opts out of Fastify's
encapsulation (it sets the same well-known symbols `fastify-plugin` uses) so the decorator and hook
apply to the parent scope — without adding a runtime dependency on `fastify-plugin`.

## Install

```bash
pnpm add @safecache/fastify @safecache/core
```

## Usage

```ts
import Fastify from "fastify";
import { createCache } from "@safecache/core";
import { safeCacheFastifyPlugin } from "@safecache/fastify";

const cache = createCache({ namespace: "app", provider, defaultTtl: "5m" });
const app = Fastify();

await app.register(safeCacheFastifyPlugin(cache));

app.get("/users/:id", async (request) => {
  const { id } = request.params as { id: string };
  return request.safeCache!.query({
    key: `user:${id}`,
    tags: [`user:${id}`],
    fetcher: () => userRepo.findById(id),
  });
});
```

The plugin decorates the request with `safeCache` (initialized to `null`) and sets it on every
`onRequest`.

## Common mistakes

- Calling routes before the plugin is registered (`await app.register(...)`).
- Forgetting that `request.safeCache` is typed as optional — guard for it in handlers.

## Related docs

- [Express middleware](express.md)
- [Core concepts](core-concepts.md)
- [Safety model](safety-model.md)
