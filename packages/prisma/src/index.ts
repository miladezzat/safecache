import { toError, type Cache, type CachePlugin } from "@safecache/core";

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

/**
 * Why a mutation could only be invalidated at the coarse (model) level instead of
 * a precise per-entity tag. Surfaced through `onUnmappableMutation` so callers can
 * observe and tighten invalidation rather than silently over- or under-invalidating.
 *
 * - `no-id`: no primary key could be inferred from the args/result and the caller
 *   supplied no explicit `tags` (e.g. a non-`id` primary key, a compound key with
 *   no extractor, or a `create` whose return value was not awaited).
 * - `scope`: a bulk operation (`updateMany` / `deleteMany`) whose `where` filter
 *   may touch many rows. A single entity tag cannot represent the affected set, so
 *   only the model tag is invalidated.
 */
export type PrismaUnmappableReason = "no-id" | "scope";

export interface PrismaUnmappableMutation {
  readonly model: string;
  readonly operation?: string;
  readonly reason: PrismaUnmappableReason;
  /** Tags that WILL still be invalidated (typically just the model tag). */
  readonly tags: readonly string[];
}

export interface PrismaTagOptions {
  modelTag?: (model: string) => string;
  entityTag?: (model: string, id: string) => string;
}

/**
 * Primary-key resolution strategy.
 *
 * SafeCache's built-in inference is intentionally shallow: it reads a literal `id`
 * field from `args.where`, `args.data`, or the operation result. Models that use a
 * different primary-key column, a compound (multi-column) key, or that mutate via
 * `updateMany` / `deleteMany` are NOT covered by the literal-`id` assumption — for
 * those, configure `idField` / `idExtractor`, or pass explicit `tags` to
 * {@link PrismaCacheSync.mutate}.
 */
export interface PrismaIdResolutionOptions {
  /**
   * The primary-key field name(s) to read instead of `id`. Provide a single name
   * for a custom primary key, or an array for a compound key (every part must be
   * present; the parts are joined with `:` in stable order to form one entity id).
   */
  idField?: string | readonly string[];
  /**
   * Full-control extractor invoked with the operation `args` and (when available)
   * the `result`. Return one id, several ids, or `undefined` when no precise key
   * can be derived. Takes precedence over `idField` and the literal-`id` default.
   */
  idExtractor?: (
    args: unknown,
    result?: unknown,
  ) => PrismaEntityId | readonly PrismaEntityId[] | undefined;
}

export interface PrismaCacheSyncOptions extends PrismaTagOptions, PrismaIdResolutionOptions {
  /**
   * When `true`, invalidation failures are re-thrown, which surfaces to the caller
   * as if the Prisma operation itself failed. Defaults to `false` so a committed
   * write is never reported as failed because the cache could not be invalidated.
   */
  propagateInvalidationErrors?: boolean;
  /**
   * Out-of-band handler invoked for every cache-side invalidation failure while
   * `propagateInvalidationErrors` is not set. Defaults to a silent no-op so library
   * code never writes to the console; wire it to your logger / Sentry / metrics.
   * Invoked defensively — a throw from this handler is swallowed.
   */
  onInvalidationError?: (error: Error, tag: string) => void;
  /**
   * Out-of-band signal invoked when a mutation could not be mapped to a precise
   * entity tag (see {@link PrismaUnmappableReason}). Lets callers observe imprecise
   * invalidation instead of it being silently skipped. Defaults to a silent no-op
   * and is invoked defensively — a throw from this handler is swallowed.
   */
  onUnmappableMutation?: (mutation: PrismaUnmappableMutation) => void;
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

/** Bulk operations whose `where` filter can match many rows. */
const scopedMutationOperations = new Set<string>(["updateMany", "deleteMany"]);

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

/**
 * Infer the entity id(s) for a mutation.
 *
 * Resolution order: a caller-supplied `idExtractor`, then a configured `idField`
 * (single or compound), then the shallow literal-`id` default. The literal-`id`
 * default only ever reads a field named `id` from `args.where` / `args.data` /
 * the result — it does NOT understand custom primary keys, compound keys, or the
 * row set behind `updateMany` / `deleteMany`. For those, configure id resolution
 * or pass explicit `tags`.
 */
export function inferPrismaMutationId(
  args: unknown,
  result?: unknown,
  options: PrismaIdResolutionOptions = {},
): PrismaEntityId[] {
  if (options.idExtractor) {
    return toEntityIdList(options.idExtractor(args, result));
  }
  if (options.idField !== undefined) {
    return inferIdsFromField(args, result, options.idField);
  }
  const id = inferIdFromArgs(args) ?? inferIdFromValue(result);
  return id === undefined ? [] : [id];
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
      // The user's action is THEIR code — it is allowed to throw and we never wrap
      // it. Only the cache-side invalidation below is guarded.
      const result = await mutation.action();
      const ids =
        mutation.id !== undefined && mutation.id !== null
          ? [mutation.id]
          : inferPrismaMutationId(undefined, result, options);
      await invalidateMutation(cache, options, {
        model: mutation.model,
        ids,
        explicitTags: mutation.tags,
      });
      return result;
    },

    async handleQuery<TArgs, TResult>(
      params: PrismaExtensionQueryParams<TArgs, TResult>,
    ): Promise<TResult> {
      // The wrapped query is THEIR code (the DB call) — it is allowed to throw.
      const result = await params.query(params.args);
      if (!isPrismaMutationOperation(params.operation)) {
        return result;
      }
      const scoped = scopedMutationOperations.has(params.operation);
      const ids = scoped ? [] : inferPrismaMutationId(params.args, result, options);
      await invalidateMutation(cache, options, {
        model: params.model,
        operation: params.operation,
        ids,
        // A bulk op that yielded no precise id is reported as a `scope` miss.
        forceScope: scoped,
      });
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

interface InvalidateMutationParams {
  model: string;
  operation?: string;
  ids: readonly PrismaEntityId[];
  explicitTags?: string[];
  forceScope?: boolean;
}

/**
 * Build the tag set for a mutation and invalidate it best-effort. When the
 * mutation could not be reduced to a precise entity tag, an `onUnmappableMutation`
 * signal is emitted so the imprecision is observable instead of silent. The cache
 * side is fully fail-open: nothing here throws into the Prisma operation unless the
 * caller opted into `propagateInvalidationErrors`.
 */
async function invalidateMutation(
  cache: PrismaCacheInvalidator,
  options: PrismaCacheSyncOptions,
  params: InvalidateMutationParams,
): Promise<void> {
  const explicitTags = params.explicitTags ?? [];
  const entityTags = params.ids.flatMap((id) =>
    prismaModelTags(params.model, id, options).slice(1),
  );
  const modelTags = prismaModelTags(params.model, undefined, options);
  const tags = [...modelTags, ...entityTags, ...explicitTags];

  // Signal when we could only invalidate at the model level. Explicit tags count
  // as the caller mapping the mutation themselves, so they suppress the signal.
  if (entityTags.length === 0 && explicitTags.length === 0) {
    const reason: PrismaUnmappableReason = params.forceScope ? "scope" : "no-id";
    notifyUnmappable(options, {
      model: params.model,
      operation: params.operation,
      reason,
      tags: modelTags,
    });
  }

  await invalidateTags(cache, tags, options);
}

async function invalidateTags(
  cache: PrismaCacheInvalidator,
  tags: string[],
  options: PrismaCacheSyncOptions,
): Promise<void> {
  const failures: Error[] = [];
  for (const tag of unique(tags)) {
    try {
      await cache.invalidateByTag(tag);
    } catch (error) {
      const normalized = toError(error);
      failures.push(normalized);
      notifyInvalidationError(options, normalized, tag);
    }
  }
  const [firstFailure] = failures;
  if (firstFailure && options.propagateInvalidationErrors) {
    throw failures.length === 1
      ? firstFailure
      : new AggregateError(failures, "Failed to invalidate one or more Prisma cache tags");
  }
}

/**
 * Invoke the invalidation-error notifier defensively. A throw from the user's
 * handler is swallowed so the notifier itself can never break a committed write.
 */
function notifyInvalidationError(options: PrismaCacheSyncOptions, error: Error, tag: string): void {
  if (!options.onInvalidationError) {
    return;
  }
  try {
    options.onInvalidationError(error, tag);
  } catch {
    // Never let the notifier escape into the host application.
  }
}

/**
 * Invoke the unmappable-mutation signal defensively. A throw from the user's
 * handler is swallowed so the signal can never break a committed write.
 */
function notifyUnmappable(
  options: PrismaCacheSyncOptions,
  mutation: PrismaUnmappableMutation,
): void {
  if (!options.onUnmappableMutation) {
    return;
  }
  try {
    options.onUnmappableMutation(mutation);
  } catch {
    // Never let the signal escape into the host application.
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

/**
 * Resolve id(s) for a configured custom or compound primary key. Reads the
 * field(s) from `args.where`, `args.data`, or the result. For a compound key every
 * part must be present in the same source; partial keys yield no id.
 */
function inferIdsFromField(
  args: unknown,
  result: unknown,
  idField: string | readonly string[],
): PrismaEntityId[] {
  const fields = typeof idField === "string" ? [idField] : idField;
  if (fields.length === 0) {
    return [];
  }
  const record = asRecord(args);
  const sources = [record?.where, record?.data, record, result];
  for (const source of sources) {
    const id = compositeIdFrom(asRecord(source), fields);
    if (id !== undefined) {
      return [id];
    }
  }
  return [];
}

/**
 * Build one entity id from the named fields of a single record. A compound key
 * may be provided either flat (`{ tenantId, userId }`) or nested under Prisma's
 * compound-key wrapper (`{ tenantId_userId: { tenantId, userId } }`).
 */
function compositeIdFrom(
  record: Record<string, unknown> | undefined,
  fields: readonly string[],
): PrismaEntityId | undefined {
  if (!record) {
    return undefined;
  }
  const source = compoundSource(record, fields);
  const values: PrismaEntityId[] = [];
  for (const field of fields) {
    const value = source[field];
    if (!isEntityId(value)) {
      return undefined;
    }
    values.push(value);
  }
  // Single custom-id field: preserve the original scalar value. Compound keys are
  // joined into one stable string id.
  const [first] = values;
  if (values.length === 1 && first !== undefined) {
    return first;
  }
  return values.map(String).join(":");
}

/**
 * Return the record that actually holds the compound-key fields. Prisma nests
 * compound keys under a synthetic `a_b_c` property; if such a wrapper containing
 * the fields exists, descend into it, otherwise read the fields flat.
 */
function compoundSource(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  if (fields.length < 2) {
    return record;
  }
  const wrapperKey = fields.join("_");
  const wrapper = asRecord(record[wrapperKey]);
  if (wrapper && fields.every((field) => field in wrapper)) {
    return wrapper;
  }
  return record;
}

function toEntityIdList(
  value: PrismaEntityId | readonly PrismaEntityId[] | undefined,
): PrismaEntityId[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(isEntityId);
  }
  return isEntityId(value) ? [value] : [];
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
