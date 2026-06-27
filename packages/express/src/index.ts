import type { Cache } from "@safecache/core";
import { toError } from "@safecache/core";

// Wire up the Express `Request` augmentation so consumers get `req.safeCache`
// typed on Express's own Request without casting. The side-effect import pulls
// in the empty runtime module express-augmentation.ts and its co-located
// express-augmentation.d.ts; tsup follows this import and inlines the
// augmentation into the published dist/index.d.ts, so anyone importing this
// package's built types gets the merged `Request` automatically. The
// augmentation does not require `@types/express` to be installed for THIS
// package to type-check, because the augmenting `.d.ts` is not part of this
// package's checked source program.
import "./express-augmentation";

export interface SafeCacheRequest {
  safeCache?: Cache;
}

export type ExpressNext = (error?: unknown) => void;
export type ExpressMiddleware<Request extends SafeCacheRequest = SafeCacheRequest> = (
  req: Request,
  res: unknown,
  next: ExpressNext,
) => void;

/**
 * Options for {@link safeCacheMiddleware}.
 */
export interface SafeCacheMiddlewareOptions {
  /**
   * Notifier invoked when attaching the cache to a request fails. SafeCache is
   * fail-open: such a failure is reported here and then swallowed so the request
   * continues exactly as if the cache were absent — it must NEVER throw into the
   * Express pipeline. Defaults to a silent no-op (library code does not log).
   */
  onError?: (error: Error) => void;
}

// Default notifier: a silent no-op. Library code must not log by default;
// consumers opt in by supplying `onError`.
const noopOnError = (_error: Error): void => {};

/**
 * Express middleware that attaches a request-scoped SafeCache reference to every
 * request as `req.safeCache`.
 *
 * SafeCache's core guarantee is that a cache-side failure never breaks the host
 * application. This middleware upholds that in the request hot path: if anything
 * goes wrong while attaching/using the cache, the error is routed to `onError`
 * and the request continues via `next()` as if the cache were absent. The only
 * value ever passed to `next(error)` would be an error from downstream
 * middleware, never a cache-side failure originating here.
 */
export function safeCacheMiddleware<Request extends SafeCacheRequest = SafeCacheRequest>(
  cache: Cache,
  options: SafeCacheMiddlewareOptions = {},
): ExpressMiddleware<Request> {
  const onError = options.onError ?? noopOnError;
  return (req, _res, next) => {
    try {
      req.safeCache = cache;
    } catch (error) {
      // Attaching the cache failed (e.g. a frozen/sealed request object or a
      // throwing setter). Report it, leave `req.safeCache` unset, and let the
      // request proceed as if no cache were available — never break the app.
      notify(onError, error);
    }
    next();
  };
}

// Invoke the notifier defensively: a throwing notifier must never escape and
// break the request, so its own failure is swallowed.
function notify(onError: (error: Error) => void, error: unknown): void {
  try {
    onError(toError(error));
  } catch {
    // Intentionally ignored — the notifier itself must not break the caller.
  }
}
