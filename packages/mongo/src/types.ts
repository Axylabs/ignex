import type { ReadConcernLike, ReadPreferenceLike, WriteConcern } from "mongodb";
import type { HookMap } from "./hooks/hooks.ts";
import type { InferDoc } from "./schema/infer.ts";
import type { ObjectField } from "./schema/types.ts";

/** A Mongo index definition usable by `createIndexes`. */
export interface IndexSpec {
  key: Record<string, 1 | -1 | "text" | "hashed" | "2dsphere">;
  options?: {
    name?: string;
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
  };
}

/** Auto-timestamp field names maintained by the ORM when `timestamps` is set. */
export interface CollectionTimestamps {
  /** Field stamped with the creation time on insert (default `createdAt`). */
  createdAt?: string;
  /** Field stamped with the modification time on every update (default `updatedAt`). */
  updatedAt?: string;
}

/**
 * Collection definition. A value of `collections` may be either a raw object
 * schema (`s.object({...})`) or a `CollectionDefinition` carrying optional
 * indexes + hooks.
 */
export interface CollectionDefinition<TSchema extends ObjectField = ObjectField> {
  schema: TSchema;
  indexes?: IndexSpec[];
  hooks?: HookMap<InferDoc<TSchema>>;
  /**
   * Auto-maintain timestamps on create/update. `true` uses the defaults
   * (`createdAt`/`updatedAt`); an object names custom fields. Fields must exist
   * in the schema for the values to be stamped.
   */
  timestamps?: CollectionTimestamps | boolean;
}

export type CollectionLike = CollectionDefinition<any> | ObjectField;

/**
 * One logical Mongo database. Keys of `collections` are the *logical* collection
 * names used in every ORM call; physical names are derived via
 * `collectionPrefix` / `collectionPhysicalNames`.
 */
export interface DBClientDefinition<
  TCollections extends Record<string, CollectionLike> = Record<string, CollectionLike>,
> {
  /** Actual MongoDB database name. */
  name: string;
  /** Connection string. Falls back to env `DB_<CONSTANT_CASE_KEY>`, then config.defaultDb. */
  dbUrl?: string;
  collections: TCollections;
  /** Prefix applied to every logical collection name to produce the physical name. */
  collectionPrefix?: string;
  collectionPrefixSeparator?: string;
  /** Per-logical-collection physical-name overrides. */
  collectionPhysicalNames?: Partial<Record<string, string>>;
  connectTimeoutMs?: number;
  readPreference?: ReadPreferenceLike;
  readConcern?: ReadConcernLike;
  writeConcern?: WriteConcern;
}

export type DbClientsDefinition = Record<
  string,
  DBClientDefinition<Record<string, CollectionLike>>
>;

/* ------------------------------------------------------------------ *
 * Schema-first type inference. Call sites never pass `<TDoc>` —
 * the collection-name literal derives the document type automatically.
 * ------------------------------------------------------------------ */

export type NormalizeCollection<T> = T extends { kind: "object" }
  ? { schema: T }
  : T extends CollectionDefinition
    ? T
    : never;

export type CollectionSchema<T> =
  T extends CollectionDefinition<infer S> ? S : T extends ObjectField ? T : never;

export type CollectionDoc<T> =
  T extends CollectionDefinition<infer S>
    ? InferDoc<S>
    : T extends ObjectField
      ? InferDoc<T>
      : never;

export type ExtractDbNames<TClients extends DbClientsDefinition> = keyof TClients & string;

export type ExtractCollectionNames<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
> = keyof TClients[TDb]["collections"] & string;

export type ExtractCollectionType<
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
  TCollection extends ExtractCollectionNames<TClients, TDb>,
> = CollectionDoc<TClients[TDb]["collections"][TCollection]>;

/** Runtime normalization: schema-or-definition → `{ schema, indexes, hooks, timestamps }`. */
export const asCollectionDefinition = (
  value: CollectionLike,
): {
  schema: ObjectField;
  indexes: IndexSpec[];
  hooks: HookMap;
  timestamps?: CollectionTimestamps;
} => {
  if (value && typeof value === "object" && "schema" in value) {
    const def = value as CollectionDefinition;
    const ts = def.timestamps;
    const timestamps =
      ts === true
        ? { createdAt: "createdAt", updatedAt: "updatedAt" }
        : ts && typeof ts === "object"
          ? ts
          : undefined;
    return {
      schema: def.schema,
      indexes: def.indexes ?? [],
      hooks: def.hooks ?? {},
      ...(timestamps ? { timestamps } : {}),
    };
  }
  return { schema: value as ObjectField, indexes: [], hooks: {} };
};
