# @safecache/cli

Command-line primitives for inspecting and operating SafeCache deployments.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/cli
```

## Usage

```ts
import { runSafeCacheCli } from "@safecache/cli";

const result = await runSafeCacheCli(["doctor"], adapter);
process.exitCode = result.exitCode;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
```

## API

- `cliCommands`
- `runSafeCacheCli`
- `createMemoryCliAdapter`

## When To Use This

Use this package to build operational commands such as doctor, stats, inspect, invalidate, warm, and benchmark.

## Related Packages

- `@safecache/core`
- `@safecache/metrics`

## Documentation

- [Cli](../../docs/cli.md)
- [Metrics](../../docs/metrics.md)
- [SafeCache README](../../README.md)
