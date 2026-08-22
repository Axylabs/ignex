/**
 * Shared op-pipeline deps for the `make*Ops` factories.
 *
 * Every op factory (`crud`, `pagination`, `aggregation`) used to hand-build the
 * same `{ trace, meta }` pair: structured start/ok/error logging + op metadata.
 * This module builds that pair once from `(logger, dbLabel, resolve,
 * wrapMongoErrors)` so the boilerplate lives in exactly one place.
 */
import type { LoggerLike } from "../utils/logger.ts";
import type { DbOpMeta } from "./trace-db-op.ts";
import { traceDbOp } from "./trace-db-op.ts";

export interface OpDeps<TC> {
  /** Log a start/ok/error trace around one DB call (optional driver-error mapping). */
  trace: <T>(meta: DbOpMeta, fn: () => T | Promise<T>) => Promise<T>;
  /** Structured log metadata for a (collection, op). */
  meta: (collection: TC, op: string) => DbOpMeta;
}

/** Build the `{ trace, meta }` op-pipeline deps shared by every op factory. */
export const makeOpDeps = <TC>(
  logger: LoggerLike,
  dbLabel: string,
  resolve: (logical: string) => string,
  wrapMongoErrors: boolean,
): OpDeps<TC> => {
  const trace = <T>(meta: DbOpMeta, fn: () => T | Promise<T>): Promise<T> =>
    traceDbOp(logger, meta, fn, { wrapMongoErrors });
  const meta = (collection: TC, op: string): DbOpMeta => ({
    collection: String(collection),
    physicalCollection: resolve(String(collection)),
    db: dbLabel,
    op,
  });
  return { trace, meta };
};
