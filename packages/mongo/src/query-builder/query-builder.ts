import type {
  Collection,
  Document,
  Filter,
  FindCursor,
  FindOptions,
  Hint,
  Sort,
  WithId,
} from "mongodb";
import type { QueryOptions } from "../service/query-options.ts";
import { DEFAULT_FIND_LIMIT } from "../shared/constants.ts";
import type { FilterInput } from "../shared/filter-types.ts";

/**
 * Execution context provided by the CRUD layer. `run` participates in the
 * uniform trace + retry + cache + in-flight-dedup pipeline and returns the
 * merged driver options to the execute closure.
 */
export interface QueryBuilderContext<TDoc extends Document> {
  physicalName: string;
  collection: Collection<TDoc>;
  run: <T>(
    opName: string,
    filter: FilterInput<TDoc>,
    execute: (driverOpts: FindOptions) => Promise<T>,
    options?: QueryOptions,
  ) => Promise<T>;
}

/**
 * Lazy, fluent, schema-typed query builder. Nothing hits the database until an
 * executor (`one`/`many`/`cursor`/`count`/`exists`) is called. Projections via
 * `select` are pushed to the driver so only requested fields are transferred.
 *
 *   await users.query('users')
 *     .where({ role: 'admin' })
 *     .sort({ createdAt: -1 })
 *     .select(['_id', 'email'])
 *     .limit(20)
 *     .many();
 */
export class QueryBuilder<TDoc extends Document, TSelection = TDoc> {
  private _filter: FilterInput<TDoc> = {};
  private _sort?: Sort;
  private _skip?: number;
  private _limit?: number;
  private _projection?: Document;
  private _options: QueryOptions = {};

  constructor(private readonly ctx: QueryBuilderContext<TDoc>) {}

  get filter(): FilterInput<TDoc> {
    return this._filter;
  }

  /** Shallow-merge a filter into the current one (later keys win). */
  where(filter: FilterInput<TDoc>): this {
    this._filter = { ...this._filter, ...filter };
    return this;
  }

  /** AND-combine the current filter with a new one. */
  and(filter: FilterInput<TDoc>): this {
    this._filter = { $and: [this._filter, filter] } as FilterInput<TDoc>;
    return this;
  }

  /** OR-combine: current filter AND (filter1 OR filter2 ...). */
  or(...filters: Array<FilterInput<TDoc>>): this {
    this._filter = { $and: [this._filter, { $or: filters }] } as FilterInput<TDoc>;
    return this;
  }

  /** Set the sort order (`{ field: 1 | -1 }`). */
  sort(sort: Sort): this {
    this._sort = sort;
    return this;
  }

  /** Skip the first `n` matching documents. */
  skip(n: number): this {
    this._skip = n;
    return this;
  }

  /** Limit the result set to `n` documents. */
  limit(n: number): this {
    this._limit = n;
    return this;
  }

  /** Project only the given fields — the projection is pushed to the driver. */
  select<const K extends keyof TSelection>(
    fields: readonly K[],
  ): QueryBuilder<TDoc, Pick<TSelection, K>> {
    const projection: Record<string, 1> = {};
    for (const field of fields) projection[field as string] = 1;
    this._projection = projection;
    return this as unknown as QueryBuilder<TDoc, Pick<TSelection, K>>;
  }

  /** Raw projection document (`{ field: 1 }` / `{ field: 0 }`). */
  project(projection: Document): this {
    this._projection = projection;
    return this;
  }

  /** Set the index hint. */
  hint(hint: Hint): this {
    this._options.hint = hint;
    return this;
  }

  /** Set the driver cursor batch size. */
  batchSize(n: number): this {
    this._options.batchSize = n;
    return this;
  }

  /** Run the query inside a transaction session. */
  session(session: NonNullable<QueryOptions["session"]>): this {
    this._options.session = session;
    return this;
  }

  /** Cap server-side execution time. */
  maxTimeMS(ms: number): this {
    this._options.maxTimeMS = ms;
    return this;
  }

  /** Bypass the read cache for this query when `false`. */
  cache(on: boolean): this {
    this._options.cache = on;
    return this;
  }

  /** Override in-flight dedup for this query when set. */
  dedupe(on: boolean): this {
    this._options.dedupe = on;
    return this;
  }

  /** Compile the builder into driver options (does not execute). */
  private compile(): FindOptions & QueryOptions {
    const out: FindOptions & QueryOptions = { ...this._options };
    if (this._sort) out.sort = this._sort;
    if (this._skip !== undefined) out.skip = this._skip;
    if (this._limit !== undefined) out.limit = this._limit;
    if (this._projection) out.projection = this._projection;
    return out;
  }

  private countOptions(): FindOptions & QueryOptions {
    // countDocuments accepts skip/limit/session/hint/maxTimeMS but NOT sort/projection.
    const out: FindOptions & QueryOptions = { ...this._options };
    if (this._skip !== undefined) out.skip = this._skip;
    if (this._limit !== undefined) out.limit = this._limit;
    return out;
  }

  /** Fetch one document (limit forced to 1). */
  async one(): Promise<WithId<TSelection> | null> {
    const options = this.compile();
    if (options.limit === undefined) options.limit = 1;
    return this.ctx.run<WithId<TSelection> | null>(
      "mongo.getOne",
      this._filter,
      (opts) =>
        this.ctx.collection.findOne(
          this._filter as unknown as Filter<TDoc>,
          opts,
        ) as unknown as Promise<WithId<TSelection> | null>,
      options,
    );
  }

  /** Fetch many documents (default limit 100 when unset). */
  async many(): Promise<WithId<TSelection>[]> {
    const options = this.compile();
    if (options.limit === undefined) options.limit = DEFAULT_FIND_LIMIT;
    return this.ctx.run<WithId<TSelection>[]>(
      "mongo.findMany",
      this._filter,
      (opts) =>
        this.ctx.collection
          .find(this._filter as unknown as Filter<TDoc>, opts)
          .toArray() as unknown as Promise<WithId<TSelection>[]>,
      options,
    );
  }

  /** Streaming cursor (raw driver cursor; no retry, applies batchSize). */
  cursor(): FindCursor<WithId<TDoc>> {
    return this.ctx.collection.find(
      this._filter as unknown as Filter<TDoc>,
      this.compile() as FindOptions,
    );
  }

  /** Count matching documents. */
  async count(): Promise<number> {
    return this.ctx.run(
      "mongo.countDocuments",
      this._filter,
      (opts) => this.ctx.collection.countDocuments(this._filter as unknown as Filter<TDoc>, opts),
      this.countOptions() as QueryOptions,
    );
  }

  /** True when at least one document matches. */
  async exists(): Promise<boolean> {
    return (await this.one()) !== null;
  }
}
