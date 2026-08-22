/**
 * Keyset (cursor) pagination strategy — `paginateCursor`: O(log n) per page,
 * stable under concurrent writes, no total count. `after` walks forward from a
 * `nextCursor`; `before` walks backward by reversing the effective sort. Sort
 * must include a unique tiebreaker (`_id`).
 */
import type { Document, FindOptions } from "mongodb";
import { BadRequest } from "../../errors/index.ts";
import { DEFAULT_FIND_LIMIT, DEFAULT_MAX_LIMIT } from "../../shared/constants.ts";
import type { FilterInput } from "../../shared/filter-types.ts";
import { buildKeysetFilter, decodeCursor, encodeCursor } from "../../shared/keyset.ts";
import { normalizePageLimit } from "../../shared/pagination-math.ts";
import type { DbClientsDefinition, ExtractCollectionNames, ExtractDbNames } from "../../types.ts";
import { defineCrudOp } from "../crud-op.ts";
import { checkDocsDrift } from "../drift.ts";
import { resolveDriftMode } from "../query-options.ts";
import type {
  CursorPage,
  CursorPaginationConfig,
  PaginationCtx,
  PaginationDocOf,
} from "./types.ts";

/** Build the `paginateCursor` closure from the shared pagination context. */
export const makePaginateCursor = <
  TClients extends DbClientsDefinition,
  TDb extends ExtractDbNames<TClients>,
>(
  ctx: PaginationCtx<TClients, TDb>,
) => {
  type C = ExtractCollectionNames<TClients, TDb>;
  type DocOf2<X extends C> = PaginationDocOf<TClients, TDb, X>;

  const { client, dbLabel, logger, opts, resolve, deps } = ctx;

  /**
   * Keyset (cursor) pagination — O(log n) per page, stable under concurrent
   * writes, no total count. `after` walks forward from a `nextCursor`;
   * `before` walks backward. Sort must include a unique tiebreaker (`_id`).
   */
  const paginateCursor = async <X extends C>(
    collection: X,
    baseFilter: FilterInput<DocOf2<X>>,
    config: CursorPaginationConfig,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyset pagination is inherently branchy
  ): Promise<CursorPage<DocOf2<X>>> => {
    const sortKeys = Object.entries(config.sort);
    if (sortKeys.length === 0) {
      throw new BadRequest(
        "paginateCursor: `sort` is required (include a unique tiebreaker like `_id`)",
      );
    }
    if (config.before !== undefined && config.after !== undefined) {
      throw new BadRequest("paginateCursor: provide either `after` or `before`, not both");
    }
    const limit = normalizePageLimit(
      { page: 1, ...(config.limit !== undefined ? { limit: config.limit } : {}) },
      config.maxLimit ?? DEFAULT_MAX_LIMIT,
      { limit: DEFAULT_FIND_LIMIT },
    ).limit;

    const backwards = config.before !== undefined && config.after === undefined;
    // In reversed space "after the cursor" == "before the cursor" in forward space.
    const effectiveSort: Record<string, 1 | -1> = backwards
      ? Object.fromEntries(sortKeys.map(([f, d]) => [f, (d * -1) as 1 | -1]))
      : config.sort;

    let filter: Document = baseFilter as Document;
    if (config.after !== undefined || config.before !== undefined) {
      const cursor = (config.after ?? config.before) as string;
      const decoded = decodeCursor(cursor);
      // Sort keys are ORDER-SENSITIVE: key precedence (primary/secondary/…)
      // defines the ordering, so a cursor built with a different key order is a
      // *different* sort and must be rejected — values are positional per key.
      if (JSON.stringify(decoded.sort) !== JSON.stringify(config.sort)) {
        throw new BadRequest("paginateCursor: cursor was created with a different sort");
      }
      if (decoded.values.length !== sortKeys.length) {
        throw new BadRequest("paginateCursor: cursor was created with a different sort");
      }
      filter = {
        $and: [baseFilter as Document, buildKeysetFilter(effectiveSort, decoded.values, "after")],
      };
    }

    const rows = await defineCrudOp(
      deps,
      collection,
      "mongo.paginateCursor",
      async (r) => {
        const findOpts: FindOptions = {
          ...(r.driverOpts as FindOptions),
          ...(r.sdk.session !== undefined ? { session: r.sdk.session } : {}),
          ...(r.sdk.maxTimeMS !== undefined ? { maxTimeMS: r.sdk.maxTimeMS } : {}),
          ...(r.sdk.hint !== undefined ? { hint: r.sdk.hint } : {}),
        };
        return client
          .collection<Document>(resolve(String(collection)))
          .find(filter, findOpts)
          .sort(effectiveSort as Document)
          .limit(limit + 1)
          .toArray();
      },
      config.queryOptions,
    );

    const hasMore = rows.length > limit;
    const page = backwards ? rows.slice(0, limit).reverse() : rows.slice(0, limit);
    checkDocsDrift(
      {
        logger,
        db: dbLabel,
        drift: resolveDriftMode(config.queryOptions?.drift, opts.drift),
        ...(opts.getSchema !== undefined ? { getSchema: opts.getSchema } : {}),
      },
      String(collection),
      "mongo.paginateCursor",
      page as unknown as Document[],
    );
    const boundary = backwards ? rows[limit] : page[page.length - 1];
    const nextCursor =
      hasMore && boundary !== undefined
        ? encodeCursor({
            sort: config.sort,
            values: sortKeys.map(([f]) => (boundary as Document)[f]),
          })
        : null;
    return { data: page as unknown as DocOf2<X>[], nextCursor, hasMore };
  };

  return { paginateCursor };
};
