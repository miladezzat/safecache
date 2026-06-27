import { toError } from "@safecache/core";
import type { Cache, QueryOptions } from "@safecache/core";

export const SAFE_CACHE = Symbol("SAFE_CACHE");

/**
 * Notifier for cache-side failures surfaced by this adapter. Mirrors the core
 * `onError` contract: it is invoked when the cache machinery throws so the host
 * application can observe a degraded cache, but the failure is never re-thrown
 * into the request. Wire it to a logger / Sentry / metrics. Defaults to a silent
 * no-op (library code must not `console.log`).
 */
export type SafeCacheErrorNotifier = (error: Error) => void;

const NOOP_ERROR_NOTIFIER: SafeCacheErrorNotifier = () => {};

export interface SafeCacheRootOptions {
  cache: Cache;
  /** See {@link SafeCacheErrorNotifier}. Defaults to a silent no-op. */
  onError?: SafeCacheErrorNotifier;
}

export interface SafeCacheAsyncOptions {
  useFactory: () => Promise<Cache> | Cache;
  /** See {@link SafeCacheErrorNotifier}. Defaults to a silent no-op. */
  onError?: SafeCacheErrorNotifier;
}

export interface SafeCacheDynamicModule {
  module: typeof SafeCacheModule;
  providers: Array<{
    provide: symbol | typeof SafeCacheService;
    useValue?: Cache | SafeCacheService;
    useFactory?: (...args: Cache[]) => Promise<Cache | SafeCacheService> | Cache | SafeCacheService;
    inject?: Array<symbol | typeof SafeCacheService>;
  }>;
  exports: Array<symbol | typeof SafeCacheService>;
}

export class SafeCacheService {
  private readonly onError: SafeCacheErrorNotifier;

  constructor(
    private readonly cache: Cache,
    onError?: SafeCacheErrorNotifier,
  ) {
    this.onError = onError ?? NOOP_ERROR_NOTIFIER;
  }

  /**
   * Fail-safe cache query. SafeCache's core is fail-open by default, so
   * provider-level failures are already swallowed there. This adapter adds a
   * second, defensive net: if the cache machinery itself throws (e.g. the user
   * configured `safety.failOpen: false`, or an unexpected internal error), the
   * error is routed to {@link onError} and the host operation continues as if
   * the cache were absent — the fetcher is invoked directly so the Nest request
   * still resolves.
   *
   * The only error allowed to propagate is the user's own `fetcher` throwing
   * (their code, not ours): if the cache invokes the fetcher and it rejects,
   * that rejection is surfaced unchanged and the fetcher is NOT retried.
   */
  async query<T>(options: QueryOptions<T>): Promise<T> {
    // Track whether the user's fetcher was entered. If the cache rejects after
    // the fetcher already ran, the rejection is the user's own and must not be
    // swallowed, nor should the fetcher run a second time.
    let fetcherEntered = false;
    const guardedOptions: QueryOptions<T> = {
      ...options,
      fetcher: () => {
        fetcherEntered = true;
        return options.fetcher();
      },
    };

    try {
      return await this.cache.query(guardedOptions);
    } catch (error) {
      // A failure that originates inside the user's fetcher is their code, not
      // a cache-side fault: re-throw it untouched.
      if (fetcherEntered) {
        throw error;
      }
      // Cache-side failure: notify and fall back to running the host operation
      // directly, exactly as if the cache were not present.
      this.onError(toError(error));
      return options.fetcher();
    }
  }

  get raw(): Cache {
    return this.cache;
  }
}

export class SafeCacheModule {
  static forRoot(options: SafeCacheRootOptions): SafeCacheDynamicModule {
    const service = new SafeCacheService(options.cache, options.onError);
    return {
      module: SafeCacheModule,
      providers: [
        { provide: SAFE_CACHE, useValue: options.cache },
        { provide: SafeCacheService, useValue: service },
      ],
      exports: [SAFE_CACHE, SafeCacheService],
    };
  }

  static forRootAsync(options: SafeCacheAsyncOptions): SafeCacheDynamicModule {
    return {
      module: SafeCacheModule,
      providers: [
        { provide: SAFE_CACHE, useFactory: options.useFactory },
        {
          provide: SafeCacheService,
          useFactory: (cache: Cache) => new SafeCacheService(cache, options.onError),
          inject: [SAFE_CACHE],
        },
      ],
      exports: [SAFE_CACHE, SafeCacheService],
    };
  }
}
