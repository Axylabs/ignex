import { withRetry } from "../mongo-helpers.ts";
import {
  type QueryOptions,
  type ResolvedQueryOptions,
  resolveQueryOptions,
} from "./query-options.ts";
import type { DbOpMeta } from "./trace-db-op.ts";

export interface CrudOpDeps<TCollection> {
  trace: <T>(meta: DbOpMeta, fn: () => T | Promise<T>) => Promise<T>;
  meta: (collection: TCollection, op: string) => DbOpMeta;
}

/**
 * The uniform op wrapper every CRUD method funnels through:
 *   resolve SDK options → trace (structured logs) → retry on transient errors.
 *
 * `execute` receives the resolved options so methods only declare the driver
 * options they forward.
 */
export const defineCrudOp = async <TCollection, TResult>(
  deps: CrudOpDeps<TCollection>,
  collection: TCollection,
  opName: string,
  execute: (resolved: ResolvedQueryOptions) => TResult | Promise<TResult>,
  options?: QueryOptions,
  write = false,
): Promise<TResult> => {
  const resolved = resolveQueryOptions(options);
  // Writes are at-least-once: retry them only when the caller opts in via
  // `retryWrites: true`. Reads are idempotent and always retried.
  const maxAttempts = write && resolved.retryWrites !== true ? 1 : resolved.maxAttempts;
  return deps.trace(deps.meta(collection, opName), async () =>
    withRetry(async () => execute(resolved), {
      maxAttempts,
      delayMs: resolved.retryDelayMs,
    }),
  );
};
