import type { Document, Filter } from "mongodb";
import { canonicalKey, DataLoader } from "../loader/dataloader.ts";
import type { RelationDef } from "./relation.ts";

export interface PopulateDeps {
  /** Fetch docs from a (logical) collection by filter. */
  findMany: (
    collection: string,
    filter: Filter<Document>,
    options?: { projection?: Document; limit?: number },
  ) => Promise<Document[]>;
}

export interface PopulateOptions {
  maxBatchSize?: number;
  cache?: boolean;
  /**
   * Cap on docs fetched per foreign-key batch (default 10_000). A `hasMany` /
   * `manyToMany` relation with more children than this is silently truncated —
   * raise the cap when you expect larger joins.
   */
  maxDocs?: number;
}

/**
 * Batch + cache loader for one foreign key path. `$in`-queries one foreign
 * collection per relation (regardless of how many source docs reference it),
 * which is what turns N+1 population into 1+N.
 */
const createForeignKeyLoader = (
  deps: PopulateDeps,
  collection: string,
  foreignField: string,
  options: PopulateOptions = {},
): DataLoader<unknown, Document[]> =>
  new DataLoader<unknown, Document[]>({
    ...(options.maxBatchSize !== undefined ? { maxBatchSize: options.maxBatchSize } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    keyOf: canonicalKey,
    batch: async (keys) => {
      const docs = await deps.findMany(
        collection,
        { [foreignField]: { $in: keys } },
        {
          ...(options.maxDocs !== undefined ? { limit: options.maxDocs } : {}),
        },
      );
      // Index foreign docs by canonical key value so distinct-but-equal keys
      // (e.g. two ObjectId instances with the same hex) resolve correctly.
      const index = new Map<string, Document[]>();
      for (const doc of docs) {
        const value = (doc as Document)[foreignField];
        const canonical = canonicalKey(value);
        const bucket = index.get(canonical) ?? [];
        bucket.push(doc);
        index.set(canonical, bucket);
      }
      const map = new Map<unknown, Document[]>();
      for (const key of keys) {
        map.set(key, index.get(canonicalKey(key)) ?? []);
      }
      return map;
    },
  });

const distinctKeys = (values: unknown[]): unknown[] => {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const canonical = canonicalKey(value);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(value);
    }
  }
  return out;
};

/**
 * Resolve relations on an array of documents using DataLoader-batched queries.
 * Mutates the source documents in place (attaching the joined value at `as`)
 * and returns them typed with the joined fields.
 *
 *   const orders = await users.findMany('orders', { userId });
 *   await populate(orders, [ belongsTo({ collection: 'customers', localField: 'customerId', as: 'customer' }) ]);
 *   // orders[i].customer is now the joined Customer document
 */
export const makePopulator = (deps: PopulateDeps) => {
  const populate = async <T extends Document>(
    docs: T[],
    relations: RelationDef[],
    options: PopulateOptions = {},
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: relation population loop is inherently branchy
  ): Promise<Array<T & Record<string, unknown>>> => {
    for (const relation of relations) {
      const target = relation.foreignField ?? "_id";
      const sourceKeys = distinctKeys(docs.map((doc) => (doc as Document)[relation.localField]));

      if (relation.type === "belongsTo") {
        const loader = createForeignKeyLoader(deps, relation.collection, target, options);
        const values = await loader.loadMany(sourceKeys);
        const byKey = new Map(sourceKeys.map((key, i) => [canonicalKey(key), values[i]]));
        for (const doc of docs) {
          const key = (doc as Document)[relation.localField];
          const match =
            key === undefined || key === null ? undefined : byKey.get(canonicalKey(key))?.[0];
          (doc as Record<string, unknown>)[relation.as] =
            match ?? (relation.optional ? undefined : null);
        }
      } else if (relation.type === "hasMany") {
        const loader = createForeignKeyLoader(deps, relation.collection, target, options);
        const values = await loader.loadMany(sourceKeys);
        const byKey = new Map(sourceKeys.map((key, i) => [canonicalKey(key), values[i] ?? []]));
        for (const doc of docs) {
          const key = (doc as Document)[relation.localField];
          (doc as Record<string, unknown>)[relation.as] =
            key === undefined || key === null ? [] : (byKey.get(canonicalKey(key)) ?? []);
        }
      } else {
        // manyToMany: source → join docs → target docs (two batched hops).
        const throughLoader = createForeignKeyLoader(
          deps,
          relation.through.collection,
          relation.through.localField,
          options,
        );
        const throughValues = await throughLoader.loadMany(sourceKeys);
        const throughByKey = new Map(
          sourceKeys.map((key, i) => [canonicalKey(key), throughValues[i] ?? []]),
        );
        const joinDocs = throughValues.flat();
        const targetKeys = distinctKeys(
          joinDocs.map((join) => (join as Document)[relation.through.foreignField]),
        );

        const targetLoader = createForeignKeyLoader(deps, relation.collection, target, options);
        const targetValues = await targetLoader.loadMany(targetKeys);
        const targetByKey = new Map(
          targetKeys.map((key, i) => [canonicalKey(key), targetValues[i] ?? []]),
        );

        for (const doc of docs) {
          const key = (doc as Document)[relation.localField];
          const joins =
            key === undefined || key === null ? [] : (throughByKey.get(canonicalKey(key)) ?? []);
          const targets = joins.flatMap(
            (join) =>
              targetByKey.get(canonicalKey((join as Document)[relation.through.foreignField])) ??
              [],
          );
          (doc as Record<string, unknown>)[relation.as] = targets;
        }
      }
    }
    return docs as Array<T & Record<string, unknown>>;
  };

  return { populate };
};

export type Populator = ReturnType<typeof makePopulator>;
