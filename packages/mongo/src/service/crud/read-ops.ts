/**
 * Read op group: every CRUD query that goes through the shared cache + dedup +
 * drift pipeline (`getOne`, `findMany`, `findActive*`, `countDocuments`,
 * `distinct`, `estimatedDocumentCount`).
 *
 * A pure function of the shared `CrudContext` — composed into `makeCrudOps`
 * (see `./index.ts`). No mutable state beyond what the context closes over.
 */
import type {
  CountDocumentsOptions,
  DistinctOptions,
  Document,
  EstimatedDocumentCountOptions,
  FindCursor,
  FindOptions,
} from "mongodb";
import { DomainError } from "../../errors/index.ts";
import { hasHook, runHooks } from "../../hooks/hooks.ts";
import { DEFAULT_FIND_LIMIT } from "../../shared/constants.ts";
import type { FilterInput } from "../../shared/filter-types.ts";
import { mergeMongoActiveFilter } from "../../shared/soft-delete.ts";
import { cloneDeep } from "../../utils/clone.ts";
import type { QueryOptions } from "../query-options.ts";
import type { ColNames, CrudContext, DocOf, FindQueryOptions } from "./context.ts";

/** Read ops produced for one database by `makeReadOps`. */
export type ReadOps<
  TClients extends import("../../types.ts").DbClientsDefinition,
  TDb extends import("../../types.ts").ExtractDbNames<TClients>,
> = ReturnType<typeof makeReadOps<TClients, TDb>>;

/**
 * Build the read op set from the shared CRUD context. `getOne`/`findMany` are
 * returned (and internally referenced) so write ops can reuse them, e.g.
 * `updateWithVersion`'s cache-bypassing version read.
 */
export const makeReadOps = <
  TClients extends import("../../types.ts").DbClientsDefinition,
  TDb extends import("../../types.ts").ExtractDbNames<TClients>,
>(
  ctx: CrudContext<TClients, TDb>,
) => {
  type C = ColNames<TClients, TDb>;
  type DocOf2<X extends C> = DocOf<TClients, TDb, X>;

  const { opts } = ctx;
  const { coll, toDriverFilter, read, normalizeFindOptions } = ctx;

  /** Fetch a single document by filter, or `null` when none matches. Cached + deduped. */
  const getOne = async <X extends C>(
    collection: X,
    filter?: FilterInput<DocOf2<X>>,
    options?: FindQueryOptions<DocOf2<X>>,
  ): Promise<DocOf2<X> | null> => {
    const f = filter ?? {};
    const o = normalizeFindOptions(options);
    const doc = await read(
      collection,
      "mongo.getOne",
      f,
      o,
      async (r) => {
        const opts: FindOptions = {
          ...(r.driverOpts as FindOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined ? { hint: r.sdk.hint } : {}),
        };
        return coll(collection).findOne(toDriverFilter(f), opts) as unknown as DocOf2<X> | null;
      },
      "one",
    );
    if (doc !== null && hasHook(opts.hooks, String(collection), "afterRead")) {
      // Isolate hook mutation from the shared cache entry: hooks receive a
      // clone so mutating `ctx.doc` can't poison the cached document (which
      // stays pristine for every subsequent cache hit).
      const exposed = cloneDeep(doc) as DocOf2<X>;
      await runHooks(opts.hooks, String(collection), "afterRead", {
        collection: String(collection),
        doc: exposed,
      });
      return exposed;
    }
    return doc;
  };

  /** Fetch a single document or throw `DomainError NOT_FOUND`. Accepts an optional custom error factory. */
  const getOneOrFail = async <X extends C>(
    collection: X,
    filter?: FilterInput<DocOf2<X>>,
    options?: FindQueryOptions<DocOf2<X>>,
    errorFactory?: (name: string) => Error,
  ): Promise<DocOf2<X>> => {
    const doc = await getOne(collection, filter, options);
    if (doc === null) {
      if (errorFactory) throw errorFactory(String(collection));
      throw new DomainError(
        "NOT_FOUND",
        `Document not found in collection "${String(collection)}"`,
        {
          collection: String(collection),
        },
      );
    }
    return doc;
  };

  /** Fetch many documents (default limit `DEFAULT_FIND_LIMIT`). Cached + deduped. */
  const findMany = async <X extends C>(
    collection: X,
    filter?: FilterInput<DocOf2<X>>,
    options?: FindQueryOptions<DocOf2<X>>,
  ): Promise<DocOf2<X>[]> => {
    const merged = normalizeFindOptions({
      ...options,
      limit: options?.limit ?? DEFAULT_FIND_LIMIT,
    });
    const docs = await read(
      collection,
      "mongo.findMany",
      filter ?? {},
      merged,
      async (r) => {
        const opts: FindOptions = {
          ...(r.driverOpts as FindOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined ? { hint: r.sdk.hint } : {}),
        };
        return coll(collection)
          .find(toDriverFilter(filter ?? {}), opts)
          .toArray() as unknown as DocOf2<X>[];
      },
      "many",
    );
    if (hasHook(opts.hooks, String(collection), "afterRead")) {
      const exposed = cloneDeep(docs) as DocOf2<X>[];
      await runHooks(opts.hooks, String(collection), "afterRead", {
        collection: String(collection),
        docs: exposed as Document[],
      });
      return exposed;
    }
    return docs;
  };

  /** Return a raw driver cursor (caller-owned — must be iterated/closed). No cache/dedup. */
  const findManyCursor = <X extends C>(
    collection: X,
    filter?: FilterInput<DocOf2<X>>,
    options?: FindQueryOptions<DocOf2<X>>,
  ): FindCursor<DocOf2<X>> => {
    const {
      session,
      hint,
      maxTimeMS,
      batchSize,
      maxAttempts: _ma,
      retryDelayMs: _rd,
      dedupe: _d,
      cache: _c,
      ...rest
    } = normalizeFindOptions(options);
    const findOpts: FindOptions = {
      ...(rest as FindOptions),
      ...(session && { session }),
      ...(hint && { hint }),
      ...(maxTimeMS && { maxTimeMS }),
      ...(batchSize && { batchSize }),
    };
    return coll(collection).find(toDriverFilter(filter ?? {}), findOpts) as unknown as FindCursor<
      DocOf2<X>
    >;
  };

  /** Find many non-soft-deleted docs (merges the active filter automatically). */
  const findActive = async <X extends C>(
    collection: X,
    filter?: FilterInput<DocOf2<X>>,
    options?: FindQueryOptions<DocOf2<X>>,
  ): Promise<DocOf2<X>[]> =>
    findMany(collection, mergeMongoActiveFilter(true, filter) as FilterInput<DocOf2<X>>, options);

  /** Find one non-soft-deleted doc (merges the active filter automatically). */
  const findActiveOne = async <X extends C>(
    collection: X,
    filter?: FilterInput<DocOf2<X>>,
    options?: FindQueryOptions<DocOf2<X>>,
  ): Promise<DocOf2<X> | null> =>
    getOne(collection, mergeMongoActiveFilter(true, filter) as FilterInput<DocOf2<X>>, options);

  /** Count documents matching a filter. Cached + deduped. */
  const countDocuments = async <X extends C>(
    collection: X,
    filter?: FilterInput<DocOf2<X>>,
    options?: CountDocumentsOptions & QueryOptions,
  ): Promise<number> =>
    read(
      collection,
      "mongo.countDocuments",
      filter ?? {},
      options,
      async (r) => {
        const opts: CountDocumentsOptions = {
          ...(r.driverOpts as CountDocumentsOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined ? { hint: r.sdk.hint } : {}),
        };
        return coll(collection).countDocuments(toDriverFilter(filter ?? {}), opts);
      },
      "none",
    );

  /** Distinct values of `field` (schema-typed); routed through cache + dedup. */
  const distinct = async <X extends C, K extends keyof DocOf2<X>>(
    collection: X,
    field: K,
    filter?: FilterInput<DocOf2<X>>,
    options?: FindQueryOptions<DocOf2<X>>,
  ): Promise<Array<DocOf2<X>[K]>> => {
    const f = filter ?? {};
    const o = normalizeFindOptions(options);
    return read(
      collection,
      "mongo.distinct",
      f,
      o,
      async (r) => {
        const opts: FindOptions = {
          ...(r.driverOpts as FindOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined ? { hint: r.sdk.hint } : {}),
        };
        return coll(collection).distinct(
          String(field),
          toDriverFilter(f),
          opts as DistinctOptions,
        ) as unknown as Array<DocOf2<X>[K]>;
      },
      "none",
    );
  };

  /** Approximate collection count from metadata (fast, not filter-aware). */
  const estimatedDocumentCount = async <X extends C>(
    collection: X,
    options?: EstimatedDocumentCountOptions & QueryOptions,
  ): Promise<number> =>
    ctx.run(
      collection,
      "mongo.estimatedDocumentCount",
      async (r) => {
        const opts: EstimatedDocumentCountOptions = {
          ...(r.driverOpts as EstimatedDocumentCountOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
        };
        return coll(collection).estimatedDocumentCount(opts);
      },
      options,
    );

  return {
    getOne,
    getOneOrFail,
    findMany,
    findManyCursor,
    findActive,
    findActiveOne,
    countDocuments,
    distinct,
    estimatedDocumentCount,
  };
};
