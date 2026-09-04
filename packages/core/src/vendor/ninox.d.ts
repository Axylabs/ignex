/**
 * Ambient type surface for the OPTIONAL `@ignex/ninox` MongoDB toolkit
 * (external ignex-mongodb repo, `bun link`-ed in full local-dev setups).
 * Mapped through the root tsconfig `paths` (mirrors the nodemailer / ioredis /
 * nova vendor pattern), so TypeScript resolves the module even when the repo
 * isn't installed.
 *
 * The surface covers only what the reference app (`packages/app`) imports —
 * the schema builder (`s`), `defineCollection` / `defineCollections`,
 * `createMongoToolkit` and the `InsertInput` / `UpdateInput` / `InferDoc`
 * helpers — keeping the toolkit types deliberately loose so real usage keeps
 * typechecking against this fallback.
 */

declare module "@ignex/ninox" {
  /** Inferred document type of a schema (loose: real docs flow as the model's). */
  export type InferDoc<T> = T extends { static: infer S } ? S : Record<string, unknown>;
  /** Insert payload for a document type. */
  export type InsertInput<T> = T;
  /** Update payload for a document type. */
  export type UpdateInput<T> = Partial<T>;

  /** Chained schema builder value (`.optional()`, `.nullable()`, …). */
  export interface SchemaValue<T = unknown> {
    optional(): SchemaValue<T | undefined>;
    nullable(): SchemaValue<T | null>;
  }

  /** A compiled object schema (carries `static` for `InferDoc`). */
  export interface ObjectSchema {
    readonly static: Record<string, unknown>;
  }

  /** The `s` schema builder — shape mirrors the ninox/TypeBox-style DSL. */
  export const s: {
    object(definition: Record<string, unknown>, meta?: { name?: string }): ObjectSchema;
    objectId(): SchemaValue<string>;
    string(): SchemaValue<string>;
    number(): SchemaValue<number>;
    integer(): SchemaValue<number>;
    boolean(): SchemaValue<boolean>;
    date(): SchemaValue<Date>;
    array<T = unknown>(of?: unknown): SchemaValue<T[]>;
    enum<T extends string>(values: readonly T[]): SchemaValue<T>;
    stringLiteral(value: string): SchemaValue<string>;
    union(...schemas: unknown[]): SchemaValue;
    record(keys: unknown, values: unknown): SchemaValue<Record<string, unknown>>;
  };

  /** A registered collection definition (returned by `defineCollection`). */
  export interface CollectionDefinition {
    name: string;
    [option: string]: unknown;
  }

  /** Register a named collection from a schema. */
  export function defineCollection(
    name: string,
    schema: unknown,
    options?: Record<string, unknown>,
  ): CollectionDefinition;
  /** Bundle multiple collection definitions for a toolkit primary. */
  export function defineCollections(...collections: unknown[]): unknown;

  /** Typed CRUD manager exposed as `service.db.primaryClient`. */
  export interface MongoCrudManager {
    getOne(collection: string, filter: unknown, options?: unknown): Promise<unknown>;
    getMany(collection: string, filter?: unknown, options?: unknown): Promise<unknown[]>;
    insertOne(
      collection: string,
      doc: unknown,
      options?: unknown,
    ): Promise<{ insertedId: unknown }>;
    insertMany(
      collection: string,
      docs: unknown[],
      options?: unknown,
    ): Promise<{ insertedIds: unknown[] }>;
    updateOne(
      collection: string,
      filter: unknown,
      update: unknown,
      options?: unknown,
    ): Promise<{ modifiedCount: number }>;
    deleteOne(
      collection: string,
      filter: unknown,
      options?: unknown,
    ): Promise<{ deletedCount: number }>;
    paginateFlexible(collection: string, filter: unknown, options?: unknown): Promise<unknown>;
    createSchema(collection: string, options?: unknown): Promise<unknown>;
  }

  /** The toolkit service returned by `createMongoToolkit`. */
  export interface NinoxService {
    db: {
      primary: unknown;
      primaryClient: MongoCrudManager;
    };
    makeConnections(): Promise<void>;
    closeConnections(): Promise<void>;
    health(): Promise<{ ok: boolean }>;
  }

  /** Create the toolkit service + migration runner from the app config. */
  export function createMongoToolkit(
    config: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): {
    service: NinoxService;
    migrations: unknown;
  };
}
