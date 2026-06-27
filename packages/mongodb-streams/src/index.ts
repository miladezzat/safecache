import type { Cache, CachePlugin, CachePluginContext } from "@safecache/core";

export type MongoChangeOperation = "insert" | "update" | "replace" | "delete";

export interface MongoChangeEvent<TDocument = Record<string, unknown>> {
  _id?: unknown;
  operationType: MongoChangeOperation | string;
  fullDocument?: TDocument | null;
  documentKey?: Record<string, unknown>;
}

export interface MongoCollectionConfig<TDocument = Record<string, unknown>> {
  id?: (document: TDocument) => unknown;
  keys?: (document: TDocument) => string[];
  tags: (document: TDocument) => string[];
  tenant?:
    | string
    | ((document: TDocument, change: MongoChangeEvent<TDocument>) => string | undefined);
}

export interface MongoInvalidationPlan {
  keys: string[];
  tags: string[];
  tenant?: string;
}

export interface MongoChangeStreamLike {
  on(event: "change", handler: (change: MongoChangeEvent) => Promise<void> | void): unknown;
  on(event: "error", handler: (error: unknown) => void): unknown;
  close?(): Promise<void> | void;
}

export interface MongoCollectionLike {
  watch(pipeline?: unknown[], options?: MongoWatchOptions): MongoChangeStreamLike;
}

export interface MongoDatabaseLike {
  collection(name: string): MongoCollectionLike;
}

export interface MongoWatchOptions {
  fullDocument?: "updateLookup" | "whenAvailable" | "required";
  resumeAfter?: unknown;
}

/**
 * Resume tokens are collection-specific in MongoDB, so they must be tracked per
 * collection. A bare token is still accepted for backwards compatibility, but it
 * is only applied as the initial `resumeAfter` for the first collection; prefer
 * the `Record<collection, token>` form to resume every watched collection
 * correctly.
 */
export type MongoResumeTokens = Record<string, unknown>;

/**
 * Bounds the automatic re-watch performed when a change stream errors (including
 * non-resumable/drop/rename/invalidate errors that would otherwise terminate the
 * stream permanently).
 */
export interface MongoReconnectOptions {
  /** Set to `false` to disable automatic re-watch. Defaults to `true`. */
  enabled?: boolean;
  /** Initial backoff delay in milliseconds. Defaults to `1000`. */
  initialDelayMs?: number;
  /** Maximum backoff delay in milliseconds. Defaults to `30000`. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Defaults to `2`. */
  factor?: number;
}

export interface MongoChangeStreamsOptions {
  db: MongoDatabaseLike;
  collections: Record<string, MongoCollectionConfig<any>>;
  /**
   * Initial resume token(s). Accepts a `Record<collection, token>` so each
   * collection resumes from its own token. A bare token is accepted for
   * backwards compatibility and applied to the first collection only.
   */
  resumeToken?: unknown;
  /**
   * Invoked whenever a collection advances its resume token. The second argument
   * carries the collection name so callers can persist tokens per collection.
   */
  onResumeToken?: (token: unknown, collection: string) => Promise<void> | void;
  watchOptions?: Omit<MongoWatchOptions, "resumeAfter">;
  /** Bounded automatic re-watch on stream error. Enabled by default. */
  reconnect?: MongoReconnectOptions;
}

export interface MongoCollectionHealth {
  ok: boolean;
  lastError?: Error;
  reconnectAttempts: number;
  lastResumeToken?: unknown;
}

export interface MongoChangeStreamsHealth {
  ok: boolean;
  collections: Record<string, MongoCollectionHealth>;
}

export interface MongoChangeStreamsPlugin extends CachePlugin {
  /** Current per-collection stream health, including reconnect state. */
  getHealth(): MongoChangeStreamsHealth;
}

export type MongoCacheLike = Pick<Cache, "invalidate" | "invalidateByTag">;

const DEFAULT_RECONNECT_INITIAL_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;
const DEFAULT_RECONNECT_FACTOR = 2;

export function requiresMongoReplicaSet(): boolean {
  return true;
}

export function mapMongoChangeToInvalidation<TDocument>(
  change: MongoChangeEvent<TDocument>,
  config: MongoCollectionConfig<TDocument>,
): MongoInvalidationPlan {
  const document = documentForChange(change, config);
  const tenant = resolveTenant(config, document, change);

  return {
    keys: unique(config.keys?.(document) ?? []),
    tags: unique(config.tags(document)),
    ...(tenant ? { tenant } : {}),
  };
}

interface CollectionState {
  readonly name: string;
  readonly config: MongoCollectionConfig<any>;
  readonly collection: MongoCollectionLike;
  resumeToken: unknown;
  stream?: MongoChangeStreamLike;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
  ok: boolean;
  lastError?: Error;
  closed: boolean;
}

export function mongoChangeStreams(options: MongoChangeStreamsOptions): MongoChangeStreamsPlugin {
  const states = new Map<string, CollectionState>();
  const reconnect = resolveReconnect(options.reconnect);
  const initialTokens = resolveInitialTokens(options);

  function startWatch(state: CollectionState, ctx: CachePluginContext): void {
    if (state.closed) {
      return;
    }

    const watchOptions: MongoWatchOptions = {
      fullDocument: "updateLookup",
      ...options.watchOptions,
      ...(state.resumeToken !== undefined ? { resumeAfter: state.resumeToken } : {}),
    };

    let stream: MongoChangeStreamLike;
    try {
      stream = state.collection.watch([], watchOptions);
    } catch (error) {
      // A synchronous watch() failure is treated the same as a stream error so
      // the collection still recovers via bounded backoff instead of silently
      // dropping invalidations.
      handleStreamError(state, ctx, error);
      return;
    }

    state.stream = stream;
    state.ok = true;

    stream.on("change", async (change) => {
      try {
        const plan = mapMongoChangeToInvalidation(change, state.config);
        await applyMongoInvalidation(ctx.cache, plan);
        if (change._id !== undefined) {
          // Track the resume token per collection so a later re-watch (or an
          // external persistence layer) resumes this collection from its own
          // position rather than a token belonging to another collection.
          state.resumeToken = change._id;
          await options.onResumeToken?.(change._id, state.name);
        }
      } catch (error) {
        ctx.emit({
          type: "error",
          operation: "mongodb-streams",
          error: toError(error),
        });
      }
    });

    stream.on("error", (error) => {
      handleStreamError(state, ctx, error);
    });
  }

  function handleStreamError(
    state: CollectionState,
    ctx: CachePluginContext,
    error: unknown,
  ): void {
    state.ok = false;
    state.lastError = toError(error);
    state.stream = undefined;

    ctx.emit({
      type: "error",
      operation: "mongodb-streams",
      error: state.lastError,
    });

    if (!reconnect.enabled || state.closed || state.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      reconnect.maxDelayMs,
      reconnect.initialDelayMs * Math.pow(reconnect.factor, state.reconnectAttempts),
    );
    state.reconnectAttempts += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      startWatch(state, ctx);
    }, delay);
    if (typeof state.reconnectTimer.unref === "function") {
      state.reconnectTimer.unref();
    }
  }

  const plugin: MongoChangeStreamsPlugin = {
    name: "safecache-mongodb-streams",

    setup(ctx: CachePluginContext) {
      for (const [collectionName, collectionConfig] of Object.entries(options.collections)) {
        const state: CollectionState = {
          name: collectionName,
          config: collectionConfig,
          collection: options.db.collection(collectionName),
          resumeToken: initialTokens[collectionName],
          reconnectAttempts: 0,
          ok: true,
          closed: false,
        };
        states.set(collectionName, state);
        startWatch(state, ctx);
      }
    },

    getHealth(): MongoChangeStreamsHealth {
      const collections: Record<string, MongoCollectionHealth> = {};
      let ok = true;
      for (const state of states.values()) {
        if (!state.ok) {
          ok = false;
        }
        collections[state.name] = {
          ok: state.ok,
          ...(state.lastError ? { lastError: state.lastError } : {}),
          reconnectAttempts: state.reconnectAttempts,
          ...(state.resumeToken !== undefined ? { lastResumeToken: state.resumeToken } : {}),
        };
      }
      return { ok, collections };
    },

    async shutdown() {
      const closing: Array<Promise<void> | void> = [];
      for (const state of states.values()) {
        state.closed = true;
        if (state.reconnectTimer) {
          clearTimeout(state.reconnectTimer);
          state.reconnectTimer = undefined;
        }
        if (state.stream?.close) {
          closing.push(state.stream.close());
        }
      }
      await Promise.all(closing);
      states.clear();
    },
  };

  return plugin;
}

function resolveReconnect(
  options: MongoReconnectOptions | undefined,
): Required<MongoReconnectOptions> {
  return {
    enabled: options?.enabled ?? true,
    initialDelayMs: options?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_MS,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS,
    factor: options?.factor ?? DEFAULT_RECONNECT_FACTOR,
  };
}

function resolveInitialTokens(options: MongoChangeStreamsOptions): MongoResumeTokens {
  const token = options.resumeToken;
  if (token === undefined) {
    return {};
  }
  if (isResumeTokenRecord(token)) {
    return token;
  }
  // Backwards compatibility: a bare token is applied to the first collection
  // only, since a single token is not valid for multiple collections.
  const [first] = Object.keys(options.collections);
  return first !== undefined ? { [first]: token } : {};
}

function isResumeTokenRecord(value: unknown): value is MongoResumeTokens {
  // A Mongo resume token is itself an opaque object (typically `{ _data: ... }`),
  // so only a plain object whose values are all themselves objects/tokens is
  // treated as a per-collection map. This keeps a bare token (which has scalar
  // fields such as `_data: string`) from being misread as a collection map.
  if (!isRecord(value)) {
    return false;
  }
  const values = Object.values(value);
  if (values.length === 0) {
    return false;
  }
  return values.every((entry) => isRecord(entry));
}

async function applyMongoInvalidation(
  cache: MongoCacheLike,
  plan: MongoInvalidationPlan,
): Promise<void> {
  for (const key of plan.keys) {
    if (plan.tenant) {
      await cache.invalidate(key, { tenant: plan.tenant });
    } else {
      await cache.invalidate(key);
    }
  }

  for (const tag of plan.tags) {
    if (plan.tenant) {
      await cache.invalidateByTag(tag, { tenant: plan.tenant });
    } else {
      await cache.invalidateByTag(tag);
    }
  }
}

function documentForChange<TDocument>(
  change: MongoChangeEvent<TDocument>,
  config: MongoCollectionConfig<TDocument>,
): TDocument {
  if (change.fullDocument) {
    return change.fullDocument;
  }

  const keyDocument = change.documentKey ?? {};
  const id = config.id?.(keyDocument as TDocument) ?? keyDocument._id ?? keyDocument.id;
  return {
    ...keyDocument,
    ...(id !== undefined ? { _id: id, id } : {}),
  } as TDocument;
}

function resolveTenant<TDocument>(
  config: MongoCollectionConfig<TDocument>,
  document: TDocument,
  change: MongoChangeEvent<TDocument>,
): string | undefined {
  if (typeof config.tenant === "function") {
    return config.tenant(document, change);
  }
  return config.tenant;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
