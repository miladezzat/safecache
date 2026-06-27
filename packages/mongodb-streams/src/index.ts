import { toError } from "@safecache/core";
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
  /**
   * Set to `true` when `tags`/`keys`/`tenant` resolvers read document fields that
   * are not present on a delete (a delete change carries only the `documentKey`,
   * typically just `_id`). When true and a delete arrives without a
   * `fullDocument`, SafeCache will NOT derive an invalidation plan from the
   * insufficient key-only document (which would invalidate the wrong/default
   * scope). Instead the delete is routed to the error notifier so the caller can
   * handle it explicitly (e.g. a broader invalidation or an out-of-band lookup).
   *
   * Leave unset/`false` when every resolver derives purely from the document key
   * (e.g. `tags: (doc) => [`user:${doc._id}`]`), which is always available.
   */
  requiresDocumentForDelete?: boolean;
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
   * Explicit per-collection initial resume tokens, keyed by collection name.
   * This is the unambiguous way to seed resume positions and is preferred over
   * `resumeToken`. When both are provided, `resumeTokens` wins for any collection
   * it names; collections it omits fall back to `resumeToken`.
   */
  resumeTokens?: MongoResumeTokens;
  /**
   * Initial resume token(s). Prefer the explicit `resumeTokens` map above; this
   * field is kept as a documented fallback. Accepts a `Record<collection, token>`
   * so each collection resumes from its own token. A bare token is accepted for
   * backwards compatibility and applied to the first collection only — the
   * record-vs-bare distinction here is a heuristic (see `isResumeTokenRecord`),
   * so use `resumeTokens` when the shape could be ambiguous.
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
  /**
   * Notifier for cache-side failures. Invoked for every error this adapter
   * encounters on the cache side: a failed invalidation while applying a change,
   * a change-stream error, or a delete that cannot be safely scoped (see
   * `MongoCollectionConfig.requiresDocumentForDelete`).
   *
   * This upholds the SafeCache safety guarantee: a failure on the cache side must
   * never throw into the host application. Errors are reported here (and via the
   * plugin context's `emit`) but the watch loop continues as if the cache were
   * absent. Defaults to a silent no-op — wire this to your logger / Sentry /
   * metrics to make a degraded cache observable. The notifier is invoked
   * defensively: if it throws, the throw is swallowed so the notifier itself can
   * never break the watch loop.
   */
  onError?: (error: Error) => void;
  /**
   * Opt in to fail-closed behavior for delete events that cannot be safely
   * scoped (see `requiresDocumentForDelete`). When `true`, such a delete throws
   * out of the change handler instead of being swallowed + notified. Defaults to
   * `false` (swallow + notify). Note that even when thrown, the error is caught
   * by the stream's change wrapper and routed to the notifier; this flag only
   * controls whether the unsafe delete is treated as an error vs a silent skip.
   */
  propagateInvalidationErrors?: boolean;
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

/**
 * Change-stream error labels/code names that mean the stored resume token is no
 * longer valid. Re-watching with the dead token would fail again immediately and
 * loop forever, so on these errors the token is cleared and the stream resumes
 * from "now" (i.e. without `resumeAfter`).
 */
const NON_RESUMABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ChangeStreamHistoryLost",
  "ChangeStreamFatalError",
  "CappedPositionLost",
  "Invalidate",
  "invalidate",
]);

/**
 * MongoDB server error codes corresponding to a dead/expired resume token.
 * 286 = ChangeStreamHistoryLost, 280 = ChangeStreamFatalError,
 * 136 = CappedPositionLost.
 */
const NON_RESUMABLE_ERROR_CODES: ReadonlySet<number> = new Set([286, 280, 136]);

/**
 * Sentinel error raised when a delete change cannot be safely scoped because the
 * collection's resolvers need document fields that are absent on delete (only
 * the `documentKey` is available). Surfaced via the error notifier so a wrong
 * (default) scope is never invalidated silently.
 */
export class MongoUnsafeDeleteError extends Error {
  readonly collection: string;
  constructor(collection: string) {
    super(
      `mongodb-streams: delete on "${collection}" cannot be safely scoped — ` +
        `its tag/key/tenant resolver requires document fields that are not ` +
        `present on a delete (only documentKey is available). Routed to the ` +
        `error notifier instead of invalidating the default scope. Set ` +
        `requiresDocumentForDelete: false only if every resolver derives from ` +
        `the document key.`,
    );
    this.name = "MongoUnsafeDeleteError";
    this.collection = collection;
  }
}

export function requiresMongoReplicaSet(): boolean {
  return true;
}

/**
 * Returns true when a change-stream error indicates the resume token is dead
 * (history lost / invalidate / capped position lost), meaning a re-watch must
 * NOT reuse the stored token. Recognizes `codeName`/`code`/`errorLabels` from
 * the MongoDB driver and falls back to the error's name/message.
 */
export function isNonResumableChangeStreamError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const codeName = error["codeName"];
  if (typeof codeName === "string" && NON_RESUMABLE_ERROR_NAMES.has(codeName)) {
    return true;
  }

  const code = error["code"];
  if (typeof code === "number" && NON_RESUMABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const labels = error["errorLabels"];
  if (Array.isArray(labels) && labels.includes("NonResumableChangeStreamError")) {
    return true;
  }

  const name = typeof error["name"] === "string" ? (error["name"] as string) : undefined;
  if (name !== undefined && NON_RESUMABLE_ERROR_NAMES.has(name)) {
    return true;
  }

  // Fallback heuristic for fakes/drivers that only surface a message.
  const message = typeof error["message"] === "string" ? (error["message"] as string) : "";
  return /change\s*stream\s*history\s*lost|invalidate|capped\s*position\s*lost/i.test(message);
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

  /**
   * Route a cache-side error to BOTH the plugin context's `emit` and the
   * user-supplied `onError` notifier. Each sink is invoked defensively: a throw
   * from one sink can never break the other or the surrounding watch loop. This
   * is the single choke point that upholds the SafeCache safety guarantee — a
   * cache-side failure is observed, then the watch loop continues as if the
   * cache were absent.
   */
  function notify(ctx: CachePluginContext, error: Error): void {
    try {
      ctx.emit({
        type: "error",
        operation: "mongodb-streams",
        error,
      });
    } catch {
      // A misbehaving emit must not break invalidation handling.
    }
    try {
      options.onError?.(error);
    } catch {
      // The notifier itself must never break the watch loop.
    }
  }

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
        if (isUnsafeDelete(change, state.config)) {
          // A delete carries only the documentKey; deriving an invalidation plan
          // from a key-only document would invalidate the wrong (default) scope.
          // Surface it instead of silently mis-invalidating. Even when the caller
          // opts into propagation, the throw is caught below and routed to the
          // notifier so the watch loop (and host) are never broken.
          const unsafe = new MongoUnsafeDeleteError(state.name);
          if (options.propagateInvalidationErrors) {
            throw unsafe;
          }
          notify(ctx, unsafe);
        } else {
          const plan = mapMongoChangeToInvalidation(change, state.config);
          await applyMongoInvalidation(ctx.cache, plan);
        }
        if (change._id !== undefined) {
          // Track the resume token per collection so a later re-watch (or an
          // external persistence layer) resumes this collection from its own
          // position rather than a token belonging to another collection. We
          // still advance the token on an unsafe delete: the event was observed
          // and routed to the notifier, so re-processing it on reconnect would
          // only re-notify, not recover anything.
          state.resumeToken = change._id;
          await options.onResumeToken?.(change._id, state.name);
        }
      } catch (error) {
        // SafeCache guarantee: a cache-side failure (including an opted-in unsafe
        // delete) is observed but never propagated into the host application.
        notify(ctx, toError(error));
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

    notify(ctx, state.lastError);

    if (isNonResumableChangeStreamError(error)) {
      // The stored resume token is dead (ChangeStreamHistoryLost / invalidate /
      // capped position lost). Re-watching with it would fail again immediately
      // and loop forever, so CLEAR it and resume from "now" (no `resumeAfter`).
      // We deliberately accept a small gap of missed changes here over a
      // permanent reconnect loop — losing the cache stream is the safe failure
      // mode (entries simply expire by TTL). The reconnect backoff counter is
      // also reset so the fresh watch starts promptly.
      state.resumeToken = undefined;
      state.reconnectAttempts = 0;
    }

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
  // Explicit per-collection map wins and is never subject to the heuristic.
  const explicit: MongoResumeTokens = isRecord(options.resumeTokens) ? options.resumeTokens : {};

  const token = options.resumeToken;
  if (token === undefined) {
    return { ...explicit };
  }
  if (isResumeTokenRecord(token)) {
    // Heuristic-typed map fallback; explicit entries take precedence over it.
    return { ...token, ...explicit };
  }
  // Backwards compatibility: a bare token is applied to the first collection
  // only, since a single token is not valid for multiple collections. An
  // explicit entry for that collection still wins.
  const [first] = Object.keys(options.collections);
  if (first === undefined) {
    return { ...explicit };
  }
  return { [first]: token, ...explicit };
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

/**
 * A delete is "unsafe" to invalidate when the collection declares that its
 * resolvers need document fields (`requiresDocumentForDelete`) but the change
 * carries no `fullDocument` — only the `documentKey`. Deriving tags/keys/tenant
 * from the key-only document would resolve the wrong (default) scope, so such a
 * delete is routed to the notifier instead of silently mis-invalidating.
 */
function isUnsafeDelete<TDocument>(
  change: MongoChangeEvent<TDocument>,
  config: MongoCollectionConfig<TDocument>,
): boolean {
  if (!config.requiresDocumentForDelete) {
    return false;
  }
  return change.operationType === "delete" && !change.fullDocument;
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
