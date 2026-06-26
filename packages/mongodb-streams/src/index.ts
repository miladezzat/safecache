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

export interface MongoChangeStreamsOptions {
  db: MongoDatabaseLike;
  collections: Record<string, MongoCollectionConfig<any>>;
  resumeToken?: unknown;
  onResumeToken?: (token: unknown) => Promise<void> | void;
  watchOptions?: Omit<MongoWatchOptions, "resumeAfter">;
}

export type MongoCacheLike = Pick<Cache, "invalidate" | "invalidateByTag">;

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

export function mongoChangeStreams(options: MongoChangeStreamsOptions): CachePlugin {
  const streams: MongoChangeStreamLike[] = [];

  return {
    name: "safecache-mongodb-streams",

    setup(ctx: CachePluginContext) {
      for (const [collectionName, collectionConfig] of Object.entries(options.collections)) {
        const collection = options.db.collection(collectionName);
        const watchOptions: MongoWatchOptions = {
          fullDocument: "updateLookup",
          ...options.watchOptions,
          ...(options.resumeToken !== undefined ? { resumeAfter: options.resumeToken } : {}),
        };
        const stream = collection.watch([], watchOptions);
        streams.push(stream);

        stream.on("change", async (change) => {
          try {
            const plan = mapMongoChangeToInvalidation(change, collectionConfig);
            await applyMongoInvalidation(ctx.cache, plan);
            if (change._id !== undefined) {
              await options.onResumeToken?.(change._id);
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
          ctx.emit({
            type: "error",
            operation: "mongodb-streams",
            error: toError(error),
          });
        });
      }
    },

    async shutdown() {
      await Promise.all(streams.map((stream) => stream.close?.()));
      streams.length = 0;
    },
  };
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
