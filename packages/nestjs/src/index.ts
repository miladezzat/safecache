import type { Cache, QueryOptions } from "@safecache/core";

export const SAFE_CACHE = Symbol("SAFE_CACHE");

export interface SafeCacheRootOptions {
  cache: Cache;
}

export interface SafeCacheAsyncOptions {
  useFactory: () => Promise<Cache> | Cache;
}

export interface SafeCacheDynamicModule {
  module: typeof SafeCacheModule;
  providers: Array<{
    provide: symbol | typeof SafeCacheService;
    useValue?: Cache | SafeCacheService;
    useFactory?: () => Promise<Cache | SafeCacheService> | Cache | SafeCacheService;
  }>;
  exports: Array<symbol | typeof SafeCacheService>;
}

export class SafeCacheService {
  constructor(private readonly cache: Cache) {}

  query<T>(options: QueryOptions<T>): Promise<T> {
    return this.cache.query(options);
  }

  get raw(): Cache {
    return this.cache;
  }
}

export class SafeCacheModule {
  static forRoot(options: SafeCacheRootOptions): SafeCacheDynamicModule {
    return {
      module: SafeCacheModule,
      providers: [
        { provide: SAFE_CACHE, useValue: options.cache },
        { provide: SafeCacheService, useValue: new SafeCacheService(options.cache) },
      ],
      exports: [SAFE_CACHE, SafeCacheService],
    };
  }

  static forRootAsync(options: SafeCacheAsyncOptions): SafeCacheDynamicModule {
    let cachePromise: Promise<Cache> | undefined;
    const getCache = () => {
      cachePromise ??= Promise.resolve(options.useFactory());
      return cachePromise;
    };

    return {
      module: SafeCacheModule,
      providers: [
        { provide: SAFE_CACHE, useFactory: getCache },
        {
          provide: SafeCacheService,
          useFactory: async () => new SafeCacheService(await getCache()),
        },
      ],
      exports: [SAFE_CACHE, SafeCacheService],
    };
  }
}
