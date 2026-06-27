// Module augmentation that merges SafeCache's request properties into Express's
// own `Request` interface, so consumers can read `req.safeCache` (and call
// `req.safeCache.query(...)`) without casting.
//
// This lives in a standalone `.d.ts` (rather than inline in `index.ts`) on
// purpose: augmenting `express-serve-static-core` requires that module to be
// resolvable at type-check time. This package does not declare a hard
// dependency on `@types/express` (consumers already bring Express and its
// types), so performing the augmentation inside a checked `.ts` source file
// would fail to compile here. As a `.d.ts` that is pulled in only via the
// side-effect import in `index.ts`, the augmentation ships in our published
// types and merges correctly in any consumer project that has Express types,
// while leaving this package's own type-check unaffected.
import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    /**
     * The request-scoped SafeCache instance attached by `safeCacheMiddleware`.
     * Optional because the middleware may not have run (or may have failed to
     * attach the cache — failures are swallowed to keep the request alive).
     */
    safeCache?: import("@safecache/core").Cache;
  }
}
