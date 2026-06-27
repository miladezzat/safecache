# CLI

The SafeCache CLI package exposes operational commands for cache diagnostics and manual
intervention. The package is also testable as a library through `runSafeCacheCli()`.

## Commands

```bash
safecache doctor
safecache stats
safecache inspect <key>
safecache invalidate <key>
safecache invalidate-tag <tag>
safecache warm
safecache benchmark
```

## Library usage

```ts
import { runSafeCacheCli } from "@safecache/cli";

const result = await runSafeCacheCli(["doctor"], adapter);

process.exitCode = result.exitCode;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
```

`doctor` returns a non-zero exit code when any configured check fails.

## Adapter shape

The CLI package does not assume one global SafeCache instance. Provide an adapter for your
environment:

```ts
const adapter = {
  doctor: async () => ({ ok: true, checks: [{ name: "redis", ok: true }] }),
  stats: async () => cache.stats(),
  invalidate: (key: string) => cache.invalidate(key),
  invalidateTag: (tag: string) => cache.invalidateByTag(tag),
};
```

## Common mistakes

- Exposing mutation commands publicly without authentication.
- Running invalidate commands without tenant context in multi-tenant systems.
- Treating `warm` and `benchmark` as production-safe without environment-specific limits.

## Related packages

- `@safecache/cli`
- `@safecache/metrics`
- `@safecache/dashboard`
