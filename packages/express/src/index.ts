import type { Cache } from "@safecache/core";

export interface SafeCacheRequest {
  safeCache?: Cache;
}

export type ExpressNext = (error?: unknown) => void;
export type ExpressMiddleware<Request extends SafeCacheRequest = SafeCacheRequest> = (
  req: Request,
  res: unknown,
  next: ExpressNext,
) => void;

export function safeCacheMiddleware<Request extends SafeCacheRequest = SafeCacheRequest>(
  cache: Cache,
): ExpressMiddleware<Request> {
  return (req, _res, next) => {
    req.safeCache = cache;
    next();
  };
}
