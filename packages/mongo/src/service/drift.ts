/**
 * Shared schema-drift checker for the read path.
 *
 * Checks freshly-fetched documents (the result of an actual DB round-trip,
 * not a cache hit) against their declared schema and either logs the drift
 * (`'report'` mode) or throws a typed `DomainError SCHEMA_DRIFT` (`'throw'`).
 * Detection-only — never mutates the documents.
 */
import type { Document } from "mongodb";
import { DomainError } from "../errors/index.ts";
import type { ObjectField } from "../schema/types.ts";
import { type DriftMode, validateDoc } from "../schema/validate-doc/index.ts";
import type { LoggerLike } from "../utils/logger.ts";

export interface DriftCheckerOptions {
  logger: LoggerLike;
  /** DB label for error/log context. */
  db: string;
  /** Effective drift mode for this read (already resolved from per-op + service). */
  drift: DriftMode;
  /** Resolve the declared schema for a logical collection. */
  getSchema?: (logical: string) => ObjectField | undefined;
}

/**
 * Validate `docs` against the collection schema and react per the drift mode.
 * No-op when `drift` is `'off'`, the collection has no schema, or the docs are
 * all conformant.
 */
export const checkDocsDrift = (
  options: DriftCheckerOptions,
  collection: string,
  op: string,
  docs: Document[],
): void => {
  if (options.drift === "off") return;
  const schema = options.getSchema?.(collection);
  if (!schema) return;
  for (const doc of docs) {
    const issues = validateDoc(schema, doc);
    if (issues.length === 0) continue;
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    const extra = { collection, db: options.db, op, issues };
    if (options.drift === "throw") {
      throw new DomainError(
        "SCHEMA_DRIFT",
        `Document drifted from schema in "${collection}": ${detail}`,
        extra,
      );
    }
    options.logger.warn(extra, `[drift] ${collection} (${options.db}, ${op}): ${detail}`);
  }
};
