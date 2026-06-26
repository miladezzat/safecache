import type { Cache, CachePlugin } from "@safecache/core";

export type PrismaEntityId = string | number | bigint;

export type PrismaMutationOperation =
  | "create"
  | "update"
  | "upsert"
  | "delete"
  | "updateMany"
  | "deleteMany";

export const prismaMutationOperations: readonly PrismaMutationOperation[] = [
  "create",
  "update",
  "upsert",
  "delete",
  "updateMany",
  "deleteMany",
] as const;

export interface PrismaTagOptions {
  modelTag?: (model: string) => string;
  entityTag?: (model: string, id: string) => string;
}

export interface PrismaCacheSyncOptions extends PrismaTagOptions {
  propagateInvalidationErrors?: boolean;
}

export interface PrismaMutateOptions<T> {
  model: string;
  id?: PrismaEntityId | null;
  tags?: string[];
  action: () => Promise<T>;
}

export interface PrismaExtensionQueryParams<TArgs = unknown, TResult = unknown> {
  model: string;
  operation: string;
  args: TArgs;
  query: (args: TArgs) => Promise<TResult>;
}

export interface PrismaCacheSync {
  readonly mutationOperations: readonly PrismaMutationOperation[];
  tagsFor(model: string, id?: PrismaEntityId | null): string[];
  invalidate(model: string, id?: PrismaEntityId | null, tags?: string[]): Promise<void>;
  mutate<T>(options: PrismaMutateOptions<T>): Promise<T>;
  handleQuery<TArgs, TResult>(params: PrismaExtensionQueryParams<TArgs, TResult>): Promise<TResult>;
  extension(): {
    name: string;
    query: {
      $allModels: Record<
        PrismaMutationOperation,
        <TArgs, TResult>(params: {
          model: string;
          args: TArgs;
          query: (args: TArgs) => Promise<TResult>;
        }) => Promise<TResult>
      >;
    };
  };
}

export type PrismaCacheInvalidator = Pick<Cache, "invalidateByTag">;

const mutationOperationSet = new Set<string>(prismaMutationOperations);

export function prismaModelTags(
  model: string,
  id?: PrismaEntityId | null,
  options: PrismaTagOptions = {},
): string[] {
  const modelTag = options.modelTag?.(model) ?? model;
  const normalizedId = normalizeId(id);
  if (!normalizedId) {
    return [modelTag];
  }
  return [modelTag, options.entityTag?.(model, normalizedId) ?? `${model}:${normalizedId}`];
}

export function isPrismaMutationOperation(operation: string): operation is PrismaMutationOperation {
  return mutationOperationSet.has(operation);
}

export function inferPrismaMutationId(args: unknown, result?: unknown): PrismaEntityId | undefined {
  return inferIdFromArgs(args) ?? inferIdFromValue(result);
}

export function createPrismaCacheSync(
  cache: PrismaCacheInvalidator,
  options: PrismaCacheSyncOptions = {},
): PrismaCacheSync {
  const sync: PrismaCacheSync = {
    mutationOperations: prismaMutationOperations,

    tagsFor(model, id) {
      return prismaModelTags(model, id, options);
    },

    async invalidate(model, id, tags = []) {
      await invalidateTags(cache, [...prismaModelTags(model, id, options), ...tags], options);
    },

    async mutate<T>(mutation: PrismaMutateOptions<T>): Promise<T> {
      const result = await mutation.action();
      await sync.invalidate(
        mutation.model,
        mutation.id ?? inferPrismaMutationId(undefined, result),
        mutation.tags,
      );
      return result;
    },

    async handleQuery<TArgs, TResult>(
      params: PrismaExtensionQueryParams<TArgs, TResult>,
    ): Promise<TResult> {
      const result = await params.query(params.args);
      if (!isPrismaMutationOperation(params.operation)) {
        return result;
      }
      await sync.invalidate(params.model, inferPrismaMutationId(params.args, result));
      return result;
    },

    extension() {
      return {
        name: "safecache-prisma",
        query: {
          $allModels: {
            create: ({ model, args, query }) =>
              sync.handleQuery({ model, operation: "create", args, query }),
            update: ({ model, args, query }) =>
              sync.handleQuery({ model, operation: "update", args, query }),
            upsert: ({ model, args, query }) =>
              sync.handleQuery({ model, operation: "upsert", args, query }),
            delete: ({ model, args, query }) =>
              sync.handleQuery({ model, operation: "delete", args, query }),
            updateMany: ({ model, args, query }) =>
              sync.handleQuery({ model, operation: "updateMany", args, query }),
            deleteMany: ({ model, args, query }) =>
              sync.handleQuery({ model, operation: "deleteMany", args, query }),
          },
        },
      };
    },
  };

  return sync;
}

export function prismaCachePlugin(): CachePlugin {
  return {
    name: "safecache-prisma",
    setup() {
      // Prisma integration is explicit through createPrismaCacheSync.
    },
  };
}

async function invalidateTags(
  cache: PrismaCacheInvalidator,
  tags: string[],
  options: PrismaCacheSyncOptions,
): Promise<void> {
  try {
    for (const tag of unique(tags)) {
      await cache.invalidateByTag(tag);
    }
  } catch (error) {
    if (options.propagateInvalidationErrors) {
      throw error;
    }
  }
}

function inferIdFromArgs(args: unknown): PrismaEntityId | undefined {
  const record = asRecord(args);
  return (
    inferIdFromValue(record?.where) ?? inferIdFromValue(record?.data) ?? inferIdFromValue(record)
  );
}

function inferIdFromValue(value: unknown): PrismaEntityId | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const id = record.id;
  if (isEntityId(id)) {
    return id;
  }
  return undefined;
}

function normalizeId(id: PrismaEntityId | null | undefined): string | undefined {
  if (id === null || id === undefined) {
    return undefined;
  }
  return String(id);
}

function isEntityId(value: unknown): value is PrismaEntityId {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint";
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
