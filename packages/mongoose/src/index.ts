import type { Cache, CachePlugin } from "@safecache/core";

export type MongooseDocumentId = string | number | bigint;

export type MongooseMutationHook =
  | "save"
  | "insertMany"
  | "updateOne"
  | "findOneAndUpdate"
  | "deleteOne"
  | "deleteMany";

export const mongooseMutationHooks: readonly MongooseMutationHook[] = [
  "save",
  "insertMany",
  "updateOne",
  "findOneAndUpdate",
  "deleteOne",
  "deleteMany",
] as const;

export interface MongooseTagOptions {
  modelTag?: (modelName: string) => string;
  documentTag?: (modelName: string, id: string) => string;
}

export interface MongooseCacheSyncOptions extends MongooseTagOptions {
  /**
   * When `true`, invalidation and model-resolution failures inside Mongoose post
   * hooks are re-thrown, which Mongoose surfaces to the caller as if the DB write
   * failed. Defaults to `false` so a committed write is never reported as failed.
   */
  propagateInvalidationErrors?: boolean;
  /**
   * Out-of-band handler invoked when invalidation or model resolution fails while
   * `propagateInvalidationErrors` is not set. Defaults to a `console.warn` logger.
   */
  onInvalidationError?: (error: Error) => void;
}

export interface MongooseSchemaLike {
  post(hook: MongooseMutationHook, handler: (this: unknown, ...args: unknown[]) => unknown): void;
}

export interface RegisterMongooseHooksOptions {
  modelName?: string;
  /**
   * When `true`, invalidation and model-resolution failures inside the post hooks
   * are re-thrown so Mongoose surfaces them to the caller. Defaults to `false` so a
   * committed write is never reported as failed.
   */
  propagateInvalidationErrors?: boolean;
  /**
   * Out-of-band handler invoked when a post hook fails while
   * `propagateInvalidationErrors` is not set. Defaults to a `console.warn` logger.
   */
  onInvalidationError?: (error: Error) => void;
}

export interface MongooseCacheSync {
  readonly hooks: readonly MongooseMutationHook[];
  tagsFor(modelName: string, id?: unknown): string[];
  invalidate(modelName: string, id?: unknown, tags?: string[]): Promise<void>;
  save(modelName: string, document: unknown): Promise<void>;
  insertMany(modelName: string, documents: unknown[]): Promise<void>;
  updateOne(modelName: string, queryOrId?: unknown): Promise<void>;
  findOneAndUpdate(modelName: string, queryOrId?: unknown, document?: unknown): Promise<void>;
  deleteOne(modelName: string, queryOrId?: unknown): Promise<void>;
  deleteMany(modelName: string, queryOrId?: unknown): Promise<void>;
}

export type MongooseCacheInvalidator = Pick<Cache, "invalidateByTag">;

export function mongooseModelTags(
  modelName: string,
  id?: unknown,
  options: MongooseTagOptions = {},
): string[] {
  const modelTag = options.modelTag?.(modelName) ?? modelName;
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    return [modelTag];
  }
  return [
    modelTag,
    options.documentTag?.(modelName, normalizedId) ?? `${modelName}:${normalizedId}`,
  ];
}

export function inferMongooseDocumentId(value: unknown): string | undefined {
  const normalized = normalizeId(value);
  if (normalized) {
    return normalized;
  }

  const record = asRecord(value);
  return normalizeId(record?._id) ?? normalizeId(record?.id) ?? inferQueryId(value);
}

export function createMongooseCacheSync(
  cache: MongooseCacheInvalidator,
  options: MongooseCacheSyncOptions = {},
): MongooseCacheSync {
  const sync: MongooseCacheSync = {
    hooks: mongooseMutationHooks,

    tagsFor(modelName, id) {
      return mongooseModelTags(modelName, id, options);
    },

    async invalidate(modelName, id, tags = []) {
      await invalidateTags(cache, [...mongooseModelTags(modelName, id, options), ...tags], options);
    },

    async save(modelName, document) {
      await sync.invalidate(modelName, inferMongooseDocumentId(document));
    },

    async insertMany(modelName, documents) {
      const tags = documents
        .map((document) => inferMongooseDocumentId(document))
        .filter((id): id is string => Boolean(id))
        .map((id) => mongooseModelTags(modelName, id, options)[1])
        .filter((tag): tag is string => Boolean(tag));
      await sync.invalidate(modelName, undefined, tags);
    },

    async updateOne(modelName, queryOrId) {
      await sync.invalidate(modelName, inferMongooseDocumentId(queryOrId));
    },

    async findOneAndUpdate(modelName, queryOrId, document) {
      await sync.invalidate(
        modelName,
        inferMongooseDocumentId(document) ?? inferMongooseDocumentId(queryOrId),
      );
    },

    async deleteOne(modelName, queryOrId) {
      await sync.invalidate(modelName, inferMongooseDocumentId(queryOrId));
    },

    async deleteMany(modelName, queryOrId) {
      await sync.invalidate(modelName, inferMongooseDocumentId(queryOrId));
    },
  };

  return sync;
}

export function registerMongooseHooks(
  schema: MongooseSchemaLike,
  sync: MongooseCacheSync,
  options: RegisterMongooseHooksOptions = {},
): void {
  const guardHook = makeHookGuard(options);

  schema.post(
    "save",
    guardHook(async function saveHook(this: unknown, document?: unknown) {
      await sync.save(resolveModelName(options.modelName, this, document), document ?? this);
    }),
  );

  schema.post(
    "insertMany",
    guardHook(async function insertManyHook(this: unknown, documents?: unknown) {
      const docs = Array.isArray(documents) ? documents : [];
      await sync.insertMany(resolveModelName(options.modelName, this, docs[0]), docs);
    }),
  );

  schema.post(
    "updateOne",
    guardHook(async function updateOneHook(this: unknown) {
      await sync.updateOne(resolveModelName(options.modelName, this), getQuery(this));
    }),
  );

  schema.post(
    "findOneAndUpdate",
    guardHook(async function findOneAndUpdateHook(this: unknown, document?: unknown) {
      await sync.findOneAndUpdate(
        resolveModelName(options.modelName, this, document),
        getQuery(this),
        document,
      );
    }),
  );

  schema.post(
    "deleteOne",
    guardHook(async function deleteOneHook(this: unknown) {
      await sync.deleteOne(resolveModelName(options.modelName, this), getQuery(this));
    }),
  );

  schema.post(
    "deleteMany",
    guardHook(async function deleteManyHook(this: unknown) {
      await sync.deleteMany(resolveModelName(options.modelName, this), getQuery(this));
    }),
  );
}

export function mongooseCachePlugin(): CachePlugin {
  return {
    name: "safecache-mongoose",
    setup() {
      // Mongoose integration is explicit through createMongooseCacheSync/registerMongooseHooks.
    },
  };
}

async function invalidateTags(
  cache: MongooseCacheInvalidator,
  tags: string[],
  options: MongooseCacheSyncOptions,
): Promise<void> {
  try {
    for (const tag of unique(tags)) {
      await cache.invalidateByTag(tag);
    }
  } catch (error) {
    if (options.propagateInvalidationErrors) {
      throw error;
    }
    reportInvalidationError(toError(error), options.onInvalidationError);
  }
}

type HookHandler = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Wraps a Mongoose post-hook body so invalidation/model-resolution errors never
 * escape and reject a committed DB write. By default errors are routed to an
 * out-of-band handler (or a `console.warn` logger); when
 * `propagateInvalidationErrors` is set the original error is re-thrown so Mongoose
 * surfaces it to the caller.
 */
function makeHookGuard(
  options: RegisterMongooseHooksOptions,
): (handler: HookHandler) => HookHandler {
  return (handler) =>
    async function guardedHook(this: unknown, ...args: unknown[]): Promise<void> {
      try {
        await handler.apply(this, args);
      } catch (error) {
        if (options.propagateInvalidationErrors) {
          throw error;
        }
        reportInvalidationError(toError(error), options.onInvalidationError);
      }
    };
}

function reportInvalidationError(error: Error, onError?: (error: Error) => void): void {
  if (onError) {
    onError(error);
    return;
  }
  console.warn("[safecache:mongoose] cache invalidation failed; write was committed", error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function inferQueryId(value: unknown): string | undefined {
  const query = getQuery(value);
  const record = asRecord(query);
  return normalizeId(record?._id) ?? normalizeId(record?.id);
}

function getQuery(value: unknown): unknown {
  const record = asRecord(value);
  const getQueryFn = record?.getQuery;
  if (typeof getQueryFn === "function") {
    return getQueryFn.call(value);
  }
  return value;
}

function resolveModelName(
  configured: string | undefined,
  context: unknown,
  document?: unknown,
): string {
  const modelName =
    configured ??
    readModelName(document) ??
    readModelName(context) ??
    readModelName(asRecord(context)?.model);

  if (!modelName) {
    throw new Error(
      "Mongoose cache hooks require a modelName or a Mongoose document/query context",
    );
  }
  return modelName;
}

function readModelName(value: unknown): string | undefined {
  const record = asRecord(value);
  const direct = record?.modelName;
  if (typeof direct === "string") {
    return direct;
  }

  const constructor = asRecord(record?.constructor);
  const fromConstructor = constructor?.modelName;
  if (typeof fromConstructor === "string") {
    return fromConstructor;
  }

  const model = asRecord(record?.model);
  const fromModel = model?.modelName;
  if (typeof fromModel === "string") {
    return fromModel;
  }

  return undefined;
}

function normalizeId(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    const toStringValue = (value as { toString?: () => string }).toString;
    if (typeof toStringValue === "function") {
      const text = toStringValue.call(value);
      if (text && text !== "[object Object]") {
        return text;
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
