export { createCache } from "./cache";
export { parseDuration } from "./duration";
export { scopeKey, scopePrefix, scopeTag } from "./keys";
export { jsonSerializer } from "./serializer";
export type {
  Cache,
  CacheEntry,
  CacheEvent,
  CacheEventBus,
  CacheEventType,
  CacheLayer,
  CacheLock,
  CacheLockHandle,
  CacheOptions,
  CachePlugin,
  CachePluginContext,
  CacheProvider,
  CacheRuntimeEvent,
  CacheRuntimeEventHandler,
  CacheRuntimeEventName,
  CacheSerializer,
  CacheStats,
  CacheTagIndex,
  CacheVersion,
  Clock,
  ConsistencyLevel,
  DurationInput,
  MutateOptions,
  ProviderHealth,
  QueryOptions,
  WrapOptions,
} from "./types";
