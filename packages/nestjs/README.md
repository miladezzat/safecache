# @safecache/nestjs

NestJS module and injectable service wrapper for SafeCache.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/nestjs @safecache/core
```

## Usage

```ts
import { SafeCacheModule, SafeCacheService } from "@safecache/nestjs";

@Module({
  imports: [SafeCacheModule.forRoot({ cache })],
})
export class AppModule {}

@Injectable()
export class UsersService {
  constructor(private readonly safeCache: SafeCacheService) {}
}
```

## API

- `SafeCacheModule`
- `SafeCacheService`
- `SAFE_CACHE`

## When To Use This

Use this package when NestJS modules should receive SafeCache through explicit dependency injection.

## Production Notes

Use `forRootAsync()` when cache construction depends on async Redis clients or configuration services.

## Related Packages

- `@safecache/core`
- `@safecache/decorators`

## Documentation

- [Nestjs Usage](../../docs/nestjs-usage.md)
- [Decorators](../../docs/decorators.md)
- [SafeCache README](../../README.md)
